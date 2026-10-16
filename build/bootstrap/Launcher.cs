using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

internal static class Launcher
{
    [STAThread]
    private static int Main()
    {
        string folder = Path.Combine(Path.GetTempPath(), "StemStudio-Setup-" + Guid.NewGuid().ToString("N"));
        string[] resources = { "Core.exe", "Setup.ps1", "Setup.xaml", "Download-Worker.ps1", "Unified-Worker.ps1", "Transfer.cs", "models.json", "version.json" };
        string logFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Stem Studio", "setup-logs");
        StringBuilder errors = new StringBuilder();
        try
        {
            Directory.CreateDirectory(folder);
            foreach (string name in resources)
            {
                using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
                {
                    if (source == null) throw new InvalidDataException("Missing setup resource: " + name);
                    using (FileStream target = new FileStream(Path.Combine(folder, name), FileMode.CreateNew, FileAccess.Write)) source.CopyTo(target);
                }
            }
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
            start.Arguments = "-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File \"" + Path.Combine(folder, "Setup.ps1") + "\"";
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            start.RedirectStandardError = true;
            start.RedirectStandardOutput = true;
            int code;
            using (Process process = new Process())
            {
                process.StartInfo = start;
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) lock (errors) errors.AppendLine(e.Data); };
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { };
                process.Start();
                process.BeginErrorReadLine();
                process.BeginOutputReadLine();
                process.WaitForExit();
                code = process.ExitCode;
            }
            if (code != 0 && code != 2) throw new InvalidOperationException("Setup could not complete. " + errors.ToString());
            return code;
        }
        catch (Exception error)
        {
            string detail = error.ToString();
            try
            {
                Directory.CreateDirectory(logFolder);
                string path = Path.Combine(logFolder, "setup-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + ".log");
                File.WriteAllText(path, detail, Encoding.UTF8);
                detail = "The setup window could not start or complete. Diagnostic details were saved to:\n\n" + path;
            }
            catch { detail = error.Message; }
            MessageBox.Show(detail, "Stem Studio Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        finally
        {
            // Delete only the exact resources created in our random temporary directory.
            foreach (string name in resources) { try { File.Delete(Path.Combine(folder, name)); } catch { } }
            foreach (string name in new[] { "services-status.json", "services-status.json.tmp", "services-result.json", "services-config.json", "services-cancel" }) { try { File.Delete(Path.Combine(folder, name)); } catch { } }
            try { Directory.Delete(folder, false); } catch { }
        }
    }
}
