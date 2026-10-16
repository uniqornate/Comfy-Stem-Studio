using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using StemStudio.Setup;

internal static class TransferOffline
{
    private sealed class FragmentedStream : MemoryStream
    {
        public FragmentedStream(byte[] bytes) : base(bytes) { }
        public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellation)
        {
            await Task.Delay(1, cancellation).ConfigureAwait(false);
            return base.Read(buffer, offset, Math.Min(count, 8192));
        }
    }
    private sealed class StalledStream : MemoryStream
    {
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellation)
        {
            return new TaskCompletionSource<int>().Task;
        }
    }
    private static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
    private static int Main()
    {
        // All streams are in memory. No network, real files, app, UI or models.
        byte[] source = new byte[512 * 1024];
        new Random(42).NextBytes(source);
        using (MemoryStream output = new MemoryStream())
        using (FragmentedStream input = new FragmentedStream(source))
        {
            ModelTransfer transfer = new ModelTransfer();
            transfer.CopyAsync(input, output, source.Length, CancellationToken.None).GetAwaiter().GetResult();
            byte[] result = output.ToArray();
            Assert(transfer.Bytes == source.Length && result.Length == source.Length, "Byte accounting failed.");
            for (int i = 0; i < source.Length; i++) Assert(result[i] == source[i], "Copied data differs.");
        }
        Console.WriteLine("PASS: delayed fragmented reads preserve exact data and byte accounting.");
        using (MemoryStream output = new MemoryStream())
        using (MemoryStream input = new MemoryStream(source))
        {
            try { new ModelTransfer().CopyAsync(input, output, 1, CancellationToken.None).GetAwaiter().GetResult(); throw new Exception("Oversize accepted."); }
            catch (InvalidDataException) { Assert(output.Length == 0, "Oversize bytes were written."); }
        }
        Console.WriteLine("PASS: oversized response rejected before writing.");
        using (MemoryStream output = new MemoryStream())
        using (MemoryStream input = new MemoryStream(new byte[1]))
        {
            try { new ModelTransfer().CopyAsync(input, output, 2, CancellationToken.None).GetAwaiter().GetResult(); throw new Exception("Truncation accepted."); }
            catch (InvalidDataException) { }
        }
        Console.WriteLine("PASS: truncated response rejected.");
        using (MemoryStream output = new MemoryStream())
        using (StalledStream input = new StalledStream())
        {
            try { new ModelTransfer().CopyAsync(input, output, 1, CancellationToken.None, 30).GetAwaiter().GetResult(); throw new Exception("Stall accepted."); }
            catch (TimeoutException) { }
        }
        Console.WriteLine("PASS: idle read timeout terminates stalled transfer.");
        using (MemoryStream output = new MemoryStream())
        using (StalledStream input = new StalledStream())
        using (CancellationTokenSource cancel = new CancellationTokenSource())
        {
            cancel.CancelAfter(30);
            try { new ModelTransfer().CopyAsync(input, output, 1, cancel.Token).GetAwaiter().GetResult(); throw new Exception("Cancellation ignored."); }
            catch (OperationCanceledException) { }
        }
        Console.WriteLine("PASS: cancellation interrupts a pending read that ignores its token.");
        return 0;
    }
}
