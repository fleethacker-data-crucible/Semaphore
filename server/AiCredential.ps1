#requires -Version 5.1
# Windows generic credential, scoped to this app and the current Windows account.
function Initialize-SemAiCredentialStore {
    if ('SemaphoreAiCredential' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security;
public static class SemaphoreAiCredential {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    private struct Credential {
        public uint Flags, Type;
        public string TargetName, Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias, UserName;
    }
    [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool ReadNative(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool WriteNative(ref Credential credential, uint flags);
    [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool DeleteNative(string target, uint type, uint flags);
    [DllImport("advapi32.dll", EntryPoint="CredFree")]
    private static extern void FreeNative(IntPtr credential);
    private static void Validate(string target) {
        if (String.IsNullOrEmpty(target) || !target.StartsWith("Semaphore/", StringComparison.Ordinal))
            throw new ArgumentException("Credential target must start with Semaphore/.");
    }
    public static string Read(string target) {
        Validate(target);
        IntPtr ptr;
        if (!ReadNative(target, 1, 0, out ptr)) {
            int error=Marshal.GetLastWin32Error();
            if (error==1168) return null;
            throw new Win32Exception(error);
        }
        try {
            Credential c=(Credential)Marshal.PtrToStructure(ptr, typeof(Credential));
            return c.CredentialBlob==IntPtr.Zero ? null : Marshal.PtrToStringUni(c.CredentialBlob, checked((int)c.CredentialBlobSize/2));
        } finally { FreeNative(ptr); }
    }
    public static void Write(string target, SecureString key) {
        Validate(target);
        IntPtr blob=Marshal.SecureStringToCoTaskMemUnicode(key);
        try {
            Credential c=new Credential();
            c.Type=1; c.TargetName=target; c.UserName="Semaphore";
            c.CredentialBlobSize=checked((uint)key.Length*2);
            c.CredentialBlob=blob; c.Persist=2;
            if (!WriteNative(ref c,0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally { Marshal.ZeroFreeCoTaskMemUnicode(blob); }
    }
    public static void Delete(string target) {
        Validate(target);
        if (!DeleteNative(target,1,0)) {
            int error=Marshal.GetLastWin32Error();
            if(error!=1168) throw new Win32Exception(error);
        }
    }
}
'@
}
function Read-SemAiCredential {
    param([string]$Target = 'Semaphore/FairleadClientKey')
    Initialize-SemAiCredentialStore
    return [SemaphoreAiCredential]::Read($Target)
}
function Save-SemAiCredential {
    param([Security.SecureString]$Key, [string]$Target = 'Semaphore/FairleadClientKey')
    $ptr = [IntPtr]::Zero
    try {
        $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Key)
        if (-not (Test-SemAiKeyShape ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)))) { throw 'That is not a Fairlead client key.' }
    } finally { if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) } }
    Initialize-SemAiCredentialStore
    [SemaphoreAiCredential]::Write($Target, $Key)
}
function Remove-SemAiCredential {
    param([string]$Target = 'Semaphore/FairleadClientKey')
    Initialize-SemAiCredentialStore
    [SemaphoreAiCredential]::Delete($Target)
}
