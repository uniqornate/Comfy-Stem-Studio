using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

// GUI host starts its console child without allocating a console window.
// Pipes and the owned process job preserve logs and application lifecycle.
internal static class QuietProcess
{
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits BasicLimitInformation; public IoCounters IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr data, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    private static string Quote(string value)
    {
        StringBuilder result=new StringBuilder("\""); int slashes=0;
        foreach(char ch in value) { if(ch=='\\') { slashes++; continue; } if(ch=='"') { result.Append('\\',slashes*2+1).Append(ch); slashes=0; continue; } result.Append('\\',slashes).Append(ch); slashes=0; }
        return result.Append('\\',slashes*2).Append('"').ToString();
    }
    [STAThread] static int Main(string[] args)
    {
        if(args.Length<1) return 64;
        IntPtr job=IntPtr.Zero;
        try {
            job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
            ExtendedLimits limits=new ExtendedLimits(); limits.BasicLimitInformation.LimitFlags=0x2000; // KILL_ON_JOB_CLOSE
            int size=Marshal.SizeOf(typeof(ExtendedLimits)); IntPtr buffer=Marshal.AllocHGlobal(size);
            try { Marshal.StructureToPtr(limits,buffer,false); if(!SetInformationJobObject(job,9,buffer,(uint)size)) throw new System.ComponentModel.Win32Exception(); } finally { Marshal.FreeHGlobal(buffer); }
            StringBuilder parameters=new StringBuilder(); for(int i=1;i<args.Length;i++) { if(i>1) parameters.Append(' '); parameters.Append(Quote(args[i])); }
            ProcessStartInfo start=new ProcessStartInfo(args[0],parameters.ToString());
            start.UseShellExecute=false; start.CreateNoWindow=true; start.WindowStyle=ProcessWindowStyle.Hidden;
            start.RedirectStandardOutput=true; start.RedirectStandardError=true; start.RedirectStandardInput=true;
            using(Process child=Process.Start(start)) {
                if(!AssignProcessToJobObject(job,child.Handle) && !child.HasExited) { try { child.Kill(); } catch {} throw new System.ComponentModel.Win32Exception(); }
                child.StandardInput.Close();
                Task stdout=child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                Task stderr=child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
                child.WaitForExit(); Task.WaitAll(stdout,stderr); return child.ExitCode;
            }
        } catch(Exception error) { try { Console.Error.WriteLine(error.Message); } catch {} return 1; }
        finally { if(job!=IntPtr.Zero) CloseHandle(job); }
    }
}
