$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if (-not [type]::GetTypeFromProgID('Word.Application')) { exit 21 }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WordWindow {
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
'@

$existingProcesses = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$word = $null
$document = $null
$wordProcess = $null
$mayQuit = $true
$security = $null
$updateLinks = $null
$exitCode = 0
$noSave = 0
try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $security = $word.AutomationSecurity
    $word.AutomationSecurity = 3
    $updateLinks = $word.Options.UpdateLinksAtOpen
    $word.Options.UpdateLinksAtOpen = $false
    # Read only, no recent files. A nonempty password avoids the interactive prompt for encrypted files.
    $document = $word.Documents.Open($env:PUDI_WORD_SOURCE, $false, $true, $false, [guid]::NewGuid().ToString())
    $window = $document.ActiveWindow
    try {
        [uint32]$wordPid = 0
        $null = [WordWindow]::GetWindowThreadProcessId([IntPtr]$window.Hwnd, [ref]$wordPid)
        if ($wordPid -in $existingProcesses) {
            $mayQuit = $false
        } elseif ($wordPid) {
            $wordProcess = Get-Process -Id $wordPid -ErrorAction SilentlyContinue
        }
    } finally {
        $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($window)
    }
    if ($env:PUDI_WORD_PAGE) {
        $page = [int]$env:PUDI_WORD_PAGE
        $document.ExportAsFixedFormat($env:PUDI_WORD_OUTPUT, 17, $false, 0, 3, $page, $page)
    } else {
        $document.ExportAsFixedFormat($env:PUDI_WORD_OUTPUT, 17)
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    $exitCode = 22
} finally {
    if ($null -ne $document) {
        try { $document.Close([ref]$noSave) } catch {}
        $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($document)
    }
    if ($null -ne $word) {
        if ($null -ne $updateLinks) {
            try { $word.Options.UpdateLinksAtOpen = $updateLinks } catch {}
        }
        if ($null -ne $security) {
            try { $word.AutomationSecurity = $security } catch {}
        }
        if ($mayQuit) {
            try {
                if ($word.Visible -or $word.Documents.Count -gt 0) {
                    $wordProcess = $null
                } else {
                    $word.Quit([ref]$noSave)
                }
            } catch {}
        }
        $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($word)
    }
    # Some Word installations keep their hidden automation process after Quit.
    # Only clean up the newly created process identified by this document's window.
    if ($null -ne $wordProcess) {
        try {
            if (-not $wordProcess.WaitForExit(1000)) {
                $wordProcess.Kill()
                $null = $wordProcess.WaitForExit(2000)
            }
        } catch {}
        $wordProcess.Dispose()
    }
}
exit $exitCode
