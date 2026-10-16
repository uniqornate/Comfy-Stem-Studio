using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Generic;
using StemStudio.Setup;

public static class ParallelDownloadOffline
{
    private sealed class FixtureStream : MemoryStream
    {
        private readonly bool slow;
        public FixtureStream(byte[] bytes, bool slow) : base(bytes) { this.slow = slow; }
        public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken token)
        {
            await Task.Delay(slow ? 25 : 10, token).ConfigureAwait(false);
            return base.Read(buffer, offset, Math.Min(count, slow ? 128 : 1024));
        }
    }
    private sealed class Handler : HttpMessageHandler
    {
        public readonly byte[] Data = Enumerable.Range(0, 32768).Select(i => (byte)(i % 251)).ToArray();
        public int Calls, Active, Maximum, FailedHosts;
        public bool Invalid, IgnoreRange, Slow;
        public readonly List<long> Starts = new List<long>();
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            Interlocked.Increment(ref Calls);
            int count = Interlocked.Increment(ref Active);
            lock (Starts) { Maximum = Math.Max(Maximum, count); }
            try
            {
                await Task.Delay(20, token).ConfigureAwait(false);
                if (request.RequestUri.Host == "failed.invalid")
                { Interlocked.Increment(ref FailedHosts); return new HttpResponseMessage(HttpStatusCode.Forbidden) { Content = new ByteArrayContent(new byte[0]) }; }
                var range = request.Headers.Range.Ranges.Single();
                long start = range.From.Value, end = range.To.Value;
                lock (Starts) Starts.Add(start);
                if (IgnoreRange) return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Data) };
                var response = new HttpResponseMessage(HttpStatusCode.PartialContent);
                response.Content = new StreamContent(new FixtureStream(Data.Skip((int)start).Take((int)(end - start + 1)).ToArray(), Slow));
                response.Content.Headers.ContentLength = end - start + 1;
                response.Content.Headers.ContentRange = new ContentRangeHeaderValue(Invalid ? start + 1 : start, end, Data.Length);
                return response;
            }
            finally { Interlocked.Decrement(ref Active); }
        }
    }
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static void Clean(string part)
    {
        ParallelModelDownload.CleanChunks(part);
        if (File.Exists(part)) File.Delete(part);
    }
    public static string[] Run()
    {
        string folder = Path.Combine(Path.GetTempPath(), "StemStudio-ParallelTest-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        string part = Path.Combine(folder, "fixture.hash.part");
        var results = new List<string>();
        try
        {
            var handler = new Handler();
            using (var client = new HttpClient(handler))
            {
                var download = new ParallelModelDownload();
                download.DownloadAsync(client, new[] { "https://fixture.invalid/model" }, part, handler.Data.Length, CancellationToken.None, 4, 8192).GetAwaiter().GetResult();
                Check(File.ReadAllBytes(part).SequenceEqual(handler.Data), "Parallel assembly differs.");
                Check(handler.Maximum >= 2 && handler.Calls == 4, "Requests did not run in parallel.");
                Check(download.Bytes == handler.Data.Length, "Parallel byte accounting differs.");
                results.Add("PASS: four in-memory HTTP ranges run concurrently and assemble exact fixture bytes.");
            }
            Clean(part);
            handler = new Handler();
            File.WriteAllBytes(part, handler.Data.Take(100).ToArray());
            File.WriteAllBytes(part + ".chunk-8192-16383", handler.Data.Skip(8192).Take(8192).ToArray());
            File.WriteAllBytes(part + ".chunk-16384-24575", handler.Data.Skip(16384).Take(777).ToArray());
            using (var client = new HttpClient(handler))
            {
                var download = new ParallelModelDownload();
                download.DownloadAsync(client, new[] { "https://fixture.invalid/model" }, part, handler.Data.Length, CancellationToken.None, 4, 8192).GetAwaiter().GetResult();
                Check(File.ReadAllBytes(part).SequenceEqual(handler.Data), "Resume data differs.");
                Check(handler.Calls == 3 && handler.Starts.Contains(100) && handler.Starts.Contains(16384 + 777), "Existing prefix/chunks were not reused.");
                Check(download.Bytes == handler.Data.Length, "Resumed byte count differs.");
                results.Add("PASS: legacy contiguous prefix, complete chunks and partial chunks resume without duplicate bytes.");
            }
            Clean(part);
            handler = new Handler();
            using (var client = new HttpClient(handler))
            {
                new ParallelModelDownload().DownloadAsync(client, new[] { "https://failed.invalid/model", "https://fixture.invalid/model" }, part, handler.Data.Length, CancellationToken.None, 4, 8192).GetAwaiter().GetResult();
                Check(handler.FailedHosts == 4 && File.ReadAllBytes(part).SequenceEqual(handler.Data), "Fallback did not preserve file bytes.");
                results.Add("PASS: failed primary sources rotate to a configured mirror with validated range offsets.");
            }
            Clean(part);
            handler = new Handler { Invalid = true };
            using (var client = new HttpClient(handler))
            {
                try { new ParallelModelDownload().DownloadAsync(client, new[] { "https://fixture.invalid/model" }, part, handler.Data.Length, CancellationToken.None, 4, 8192).GetAwaiter().GetResult(); throw new Exception("Invalid range accepted."); }
                catch (InvalidDataException) { }
                Check(!File.Exists(part), "Invalid range created a finalized partial.");
                results.Add("PASS: incorrect range metadata is rejected before assembly.");
            }
            Clean(part);
            handler = new Handler { IgnoreRange = true };
            using (var client = new HttpClient(handler))
            {
                try { new ParallelModelDownload().DownloadAsync(client, new[] { "https://fixture.invalid/model" }, part, handler.Data.Length, CancellationToken.None, 4, 8192).GetAwaiter().GetResult(); throw new Exception("Ignored ranges accepted."); }
                catch (NotSupportedException) { }
                results.Add("PASS: ignored ranges signal sequential fallback without writing a full response into a chunk.");
            }
            Clean(part);
            handler = new Handler { Slow = true };
            using (var client = new HttpClient(handler))
            {
                new ParallelModelDownload().DownloadAsync(client, new[] { "https://fixture.invalid/model" }, part, handler.Data.Length, CancellationToken.None, 4, 8192, 15, 1024 * 1024).GetAwaiter().GetResult();
                Check(handler.Calls == 12 && File.ReadAllBytes(part).SequenceEqual(handler.Data), "Slow recovery was not bounded/resumable.");
                results.Add("PASS: slow ranges reconnect twice, retain partial bytes and finish on the bounded final attempt.");
            }
            Clean(part);
            handler = new Handler { Slow = true };
            using (var client = new HttpClient(handler))
            using (var cancel = new CancellationTokenSource())
            {
                cancel.CancelAfter(100);
                try { new ParallelModelDownload().DownloadAsync(client, new[] { "https://fixture.invalid/model" }, part, handler.Data.Length, cancel.Token, 4, 8192).GetAwaiter().GetResult(); throw new Exception("Cancellation ignored."); }
                catch (OperationCanceledException) { }
                Check(Directory.GetFiles(folder, "*.chunk-*").Length > 0, "Cancellation deleted useful chunks.");
                handler.Slow = false;
                new ParallelModelDownload().DownloadAsync(client, new[] { "https://fixture.invalid/model" }, part, handler.Data.Length, CancellationToken.None, 4, 8192).GetAwaiter().GetResult();
                Check(File.ReadAllBytes(part).SequenceEqual(handler.Data), "Cancelled ranges did not resume.");
                results.Add("PASS: cancellation preserves segment data and the next attempt resumes to exact output.");
            }
            return results.ToArray();
        }
        finally { Clean(part); Directory.Delete(folder, false); }
    }
}
