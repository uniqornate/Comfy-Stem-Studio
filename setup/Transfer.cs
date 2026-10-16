using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Security.Cryptography;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text.RegularExpressions;

namespace StemStudio.Setup
{
    public sealed class ParallelModelDownload
    {
        private long bytes;
        private long networkBytes;
        private string status = "Preparing resumable ranges";
        public long Bytes { get { return Interlocked.Read(ref bytes); } }
        public long NetworkBytes { get { return Interlocked.Read(ref networkBytes); } }
        public string Status { get { return Volatile.Read(ref status); } }

        public static void CleanChunks(string partial)
        {
            string folder = Path.GetDirectoryName(partial);
            string prefix = Path.GetFileName(partial) + ".chunk-";
            foreach (string path in Directory.GetFiles(folder, prefix + "*"))
                if (Regex.IsMatch(Path.GetFileName(path), "^" + Regex.Escape(prefix) + @"\d+-\d+$")) File.Delete(path);
        }

        public async Task DownloadAsync(HttpClient client, string[] sources, string partial, long total,
            CancellationToken cancellation, int connections = 4, int blockSize = 8 * 1024 * 1024,
            int slowWindowMilliseconds = 12000, long minimumBytesPerSecond = 256 * 1024)
        {
            if (sources.Length == 0 || connections < 1 || connections > 8 || blockSize < 1) throw new ArgumentException("Invalid download configuration.");
            ServicePointManager.DefaultConnectionLimit = Math.Max(ServicePointManager.DefaultConnectionLimit, connections);
            foreach (string source in sources)
            {
                Uri uri = new Uri(source);
                if (uri.Scheme != "https") throw new ArgumentException("Only HTTPS model sources are allowed.");
                ServicePointManager.FindServicePoint(uri).ConnectionLimit = connections;
            }
            long prefix = File.Exists(partial) ? new FileInfo(partial).Length : 0;
            if (prefix > total) throw new InvalidDataException("Partial data exceeds expected file size.");
            Interlocked.Exchange(ref bytes, prefix);
            Interlocked.Exchange(ref networkBytes, 0);
            var ranges = new List<Tuple<long, long, string>>();
            for (long start = prefix; start < total;)
            {
                long end = Math.Min(total, (start / blockSize + 1) * blockSize) - 1;
                ranges.Add(Tuple.Create(start, end, partial + ".chunk-" + start + "-" + end));
                start = end + 1;
            }
            Exception firstFailure = null;
            using (var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
            using (var slots = new SemaphoreSlim(connections))
            {
                var tasks = ranges.Select(async range =>
                {
                    await slots.WaitAsync(linked.Token).ConfigureAwait(false);
                    try { await DownloadRange(client, sources, range.Item3, range.Item1, range.Item2, total, linked.Token, slowWindowMilliseconds, minimumBytesPerSecond).ConfigureAwait(false); }
                    catch (Exception error) { if (!(error is OperationCanceledException)) Interlocked.CompareExchange(ref firstFailure, error, null); linked.Cancel(); throw; }
                    finally { slots.Release(); }
                }).ToArray();
                try { await Task.WhenAll(tasks).ConfigureAwait(false); }
                catch { cancellation.ThrowIfCancellationRequested(); if (firstFailure != null) throw firstFailure; throw; }
            }
            status = "Assembling verified-size ranges";
            using (var output = new FileStream(partial, FileMode.OpenOrCreate, FileAccess.Write, FileShare.None, 1024 * 1024, true))
            {
                if (output.Length != prefix) throw new IOException("The partial file changed while downloading.");
                output.Position = prefix;
                foreach (var range in ranges)
                using (var input = File.OpenRead(range.Item3))
                    await new ModelTransfer().CopyAsync(input, output, range.Item2 - range.Item1 + 1, cancellation).ConfigureAwait(false);
            }
            // The caller verifies the complete model hash before finalizing and deleting chunks.
        }

        private async Task DownloadRange(HttpClient client, string[] sources, string path, long start, long end, long total,
            CancellationToken cancellation, int slowWindowMilliseconds, long minimumBytesPerSecond)
        {
            long expected = end - start + 1;
            long present = File.Exists(path) ? new FileInfo(path).Length : 0;
            if (present > expected) { File.Delete(path); present = 0; }
            Interlocked.Add(ref bytes, present);
            if (present == expected) return;
            Exception last = null;
            for (int attempt = 0; attempt < Math.Max(3, sources.Length); attempt++)
            {
                cancellation.ThrowIfCancellationRequested();
                string source = sources[attempt % sources.Length];
                string host = new Uri(source).Host;
                status = (attempt == 0 ? "Downloading" : "Reconnecting/resuming") + " from " + host + " (4 parallel connections)";
                present = File.Exists(path) ? new FileInfo(path).Length : 0;
                using (var request = new HttpRequestMessage(HttpMethod.Get, source))
                using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
                {
                    request.Headers.Range = new RangeHeaderValue(start + present, end);
                    request.Headers.AcceptEncoding.ParseAdd("identity");
                    request.Headers.CacheControl = new CacheControlHeaderValue { NoCache = true };
                    timeout.CancelAfter(30000);
                    try
                    {
                        using (var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false))
                        {
                            timeout.CancelAfter(Timeout.Infinite);
                            if (response.StatusCode == HttpStatusCode.OK) throw new NotSupportedException("Range requests unsupported by " + host);
                            if (response.StatusCode != HttpStatusCode.PartialContent) throw new IOException(host + " HTTP " + (int)response.StatusCode);
                            var range = response.Content.Headers.ContentRange;
                            if (range == null || range.From != start + present || range.To != end || range.Length != total)
                                throw new InvalidDataException("Invalid range returned by " + host);
                            if (response.Content.Headers.ContentLength.HasValue && response.Content.Headers.ContentLength.Value != expected - present)
                                throw new InvalidDataException("Unexpected range size from " + host);
                            using (var input = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                            using (var output = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.None, 1024 * 1024, true))
                            {
                                byte[] buffer = new byte[1024 * 1024];
                                var watch = Stopwatch.StartNew(); long received = 0;
                                while (present < expected)
                                {
                                    cancellation.ThrowIfCancellationRequested();
                                    Task<int> read = input.ReadAsync(buffer, 0, (int)Math.Min(buffer.Length, expected - present), cancellation);
                                    using (var idle = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
                                    {
                                        if (await Task.WhenAny(read, Task.Delay(30000, idle.Token)).ConfigureAwait(false) != read)
                                        { input.Dispose(); cancellation.ThrowIfCancellationRequested(); throw new TimeoutException("Stalled range from " + host); }
                                        idle.Cancel();
                                    }
                                    int count = await read.ConfigureAwait(false);
                                    if (count == 0) throw new IOException("Truncated range from " + host);
                                    await output.WriteAsync(buffer, 0, count, cancellation).ConfigureAwait(false);
                                    present += count; received += count; Interlocked.Add(ref bytes, count); Interlocked.Add(ref networkBytes, count);
                                    // Retry slow connections twice, then accept a slow final transfer
                                    // rather than looping forever or throwing away useful partial data.
                                    if (present < expected && attempt < Math.Max(3, sources.Length) - 1 && watch.ElapsedMilliseconds >= slowWindowMilliseconds &&
                                        received / Math.Max(0.001, watch.Elapsed.TotalSeconds) < minimumBytesPerSecond)
                                        throw new IOException("Slow connection to " + host + "; rotating source and resuming");
                                }
                            }
                        }
                        return;
                    }
                    catch (Exception error)
                    {
                        cancellation.ThrowIfCancellationRequested(); last = error;
                        if (attempt == Math.Max(3, sources.Length) - 1) throw;
                    }
                }
            }
            throw last ?? new IOException("Download failed.");
        }
    }

    // No UI, HTTP requests or PowerShell callbacks in the streaming hot path.
    public sealed class ModelTransfer
    {
        private long bytes;
        public long Bytes { get { return Interlocked.Read(ref bytes); } }

        public static string HashFile(string path, string algorithm)
        {
            HashAlgorithm hash;
            if (algorithm == "SHA256") hash = SHA256.Create();
            else if (algorithm == "MD5") hash = MD5.Create();
            else throw new ArgumentException("Unsupported file hash algorithm.");
            using (hash)
            using (FileStream stream = File.OpenRead(path))
                return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "");
        }

        public async Task CopyAsync(Stream input, Stream output, long expectedBytes, CancellationToken cancellation, int idleTimeoutMilliseconds = 60000)
        {
            Interlocked.Exchange(ref bytes, 0);
            byte[] buffer = new byte[1024 * 1024];
            while (true)
            {
                cancellation.ThrowIfCancellationRequested();
                int count;
                using (CancellationTokenSource idle = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
                {
                    Task<int> read = input.ReadAsync(buffer, 0, buffer.Length, cancellation);
                    Task deadline = Task.Delay(idleTimeoutMilliseconds, idle.Token);
                    if (await Task.WhenAny(read, deadline).ConfigureAwait(false) != read)
                    {
                        // Some .NET Framework network streams ignore cancellation while reading.
                        input.Dispose();
                        cancellation.ThrowIfCancellationRequested();
                        throw new TimeoutException("Download stalled. Retry when the connection is available.");
                    }
                    idle.Cancel();
                    count = await read.ConfigureAwait(false);
                }
                if (count == 0) break;
                long next = Bytes + count;
                if (next > expectedBytes) throw new InvalidDataException("Downloaded file exceeds its expected size.");
                await output.WriteAsync(buffer, 0, count, cancellation).ConfigureAwait(false);
                Interlocked.Exchange(ref bytes, next);
            }
            if (Bytes != expectedBytes) throw new InvalidDataException("Download ended before the expected file size was received.");
        }
    }
}
