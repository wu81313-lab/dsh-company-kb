# dsh-company-kb OCR / Word helper (Windows PowerShell 5.1, ASCII only).
#
# Why a helper process: the Windows built-in OCR engine and Windows.Data.Pdf are
# WinRT APIs. Node cannot call them, and Windows PowerShell 5.1 is the only host
# that projects WinRT types without extra packages. The parent (lib/ocr.js)
# passes a job list by file and reads results from a file, so no stdout pipe is
# involved and a large batch cannot deadlock.
#
# Jobs:
#   { id, kind: 'image', path }
#   { id, kind: 'pdf',   path, maxPages, width }
#   { id, kind: 'doc',   path }            (Word COM; legacy .doc/.xls)
# Results:
#   { capabilities, results: [ { id, ok, kind, error, text, pages: [ {n,text} ], meta } ] }

param(
    [Parameter(Mandatory = $true)][string]$Job,
    [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$capabilities = [ordered]@{
    platform = 'windows'
    ocr      = $false
    ocrLangs = @()
    pdf      = $false
    word     = $false
    note     = ''
}

$notes = New-Object System.Collections.ArrayList

# ---------------------------------------------------------------- WinRT types
$hasStorageFile = $false
$hasStreams = $false
$hasImaging = $false
$hasOcr = $false
$hasLanguage = $false
$hasPdf = $false

try { $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]; $hasStorageFile = $true } catch { [void]$notes.Add('StorageFile unavailable') }
try { $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]; $hasStreams = $true } catch { [void]$notes.Add('IRandomAccessStream unavailable') }
try { $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]; $hasStreams = $true } catch { [void]$notes.Add('InMemoryRandomAccessStream unavailable') }
try { $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]; $hasImaging = $true } catch { [void]$notes.Add('BitmapDecoder unavailable') }
try { $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]; $hasImaging = $true } catch { [void]$notes.Add('SoftwareBitmap unavailable') }
try { $null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]; $hasOcr = $true } catch { [void]$notes.Add('OcrEngine unavailable') }
try { $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]; $hasLanguage = $true } catch { [void]$notes.Add('Language unavailable') }
try { $null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]; $hasPdf = $true } catch { [void]$notes.Add('PdfDocument unavailable') }
try { $null = [Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime]; $hasPdf = $true } catch { [void]$notes.Add('PdfPageRenderOptions unavailable') }

# ------------------------------------------------------------- async plumbing
$script:asTaskGeneric = $null
$script:asTaskAction = $null
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    $methods = [System.WindowsRuntimeSystemExtensions].GetMethods()
    $script:asTaskGeneric = ($methods | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    $script:asTaskAction = ($methods | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
    })[0]
} catch {
    [void]$notes.Add("System.Runtime.WindowsRuntime unavailable: $($_.Exception.Message)")
}

function Await($operation, $resultType) {
    if ($null -eq $script:asTaskGeneric) { throw 'WinRT async bridge unavailable' }
    $method = $script:asTaskGeneric.MakeGenericMethod($resultType)
    $task = $method.Invoke($null, @($operation))
    $task.Wait(-1) | Out-Null
    return $task.Result
}

function AwaitAction($action) {
    if ($null -eq $script:asTaskAction) { throw 'WinRT async bridge unavailable' }
    $task = $script:asTaskAction.Invoke($null, @($action))
    $task.Wait(-1) | Out-Null
}

# ------------------------------------------------------------------ OCR engine
$script:ocrEngine = $null
if ($hasOcr -and $hasLanguage) {
    foreach ($tag in @('zh-CN', 'zh-Hans-CN', 'en-US')) {
        try {
            $candidate = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language $tag))
            if ($null -ne $candidate) { $script:ocrEngine = $candidate; break }
        } catch {
            [void]$notes.Add("OCR language $tag failed: $($_.Exception.Message)")
        }
    }
    if ($null -eq $script:ocrEngine) {
        try { $script:ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch { }
    }
    try {
        $capabilities.ocrLangs = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
    } catch { }
}
$capabilities.ocr = ($null -ne $script:ocrEngine)
$capabilities.pdf = ($hasPdf -and $hasStorageFile -and $hasStreams -and $capabilities.ocr)

# Word COM availability is probed through the registry; the COM object itself is
# created lazily and reused for every .doc job in the batch (one Word launch per
# batch instead of one per file).
try {
    $null = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Classes\Word.Application\CLSID' -ErrorAction Stop
    $capabilities.word = $true
} catch {
    try {
        $null = Get-ItemProperty -Path 'HKCU:\SOFTWARE\Classes\Word.Application\CLSID' -ErrorAction Stop
        $capabilities.word = $true
    } catch { }
}

$script:wordType = $null
$script:wordApp = $null
$script:getProp = [Reflection.BindingFlags]::GetProperty
$script:setProp = [Reflection.BindingFlags]::SetProperty
$script:invokeMethod = [Reflection.BindingFlags]::InvokeMethod

# Late binding on purpose: on some Office installs the registered interop cannot
# be cast to _Application (HRESULT 0x8002802B), so every member call goes
# through IDispatch via reflection instead of a strongly typed property.
function Get-WordApp {
    if ($null -ne $script:wordApp) { return $script:wordApp }
    if ($null -eq $script:wordType) {
        $script:wordType = [Type]::GetTypeFromProgID('Word.Application')
        if ($null -eq $script:wordType) { throw 'Word.Application ProgID is not registered' }
    }
    $app = [Activator]::CreateInstance($script:wordType)
    try { $script:wordType.InvokeMember('Visible', $script:setProp, $null, $app, @($false)) | Out-Null } catch { }
    try { $script:wordType.InvokeMember('DisplayAlerts', $script:setProp, $null, $app, @(0)) | Out-Null } catch { }
    try { $script:wordType.InvokeMember('AutomationSecurity', $script:setProp, $null, $app, @(3)) | Out-Null } catch { }
    $script:wordApp = $app
    return $app
}

function Close-WordApp {
    if ($null -eq $script:wordApp) { return }
    $app = $script:wordApp
    $script:wordApp = $null
    try { $script:wordType.InvokeMember('Quit', $script:invokeMethod, $null, $app, @()) | Out-Null } catch { }
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch { }
    [GC]::Collect()
}

function Read-WordText($path) {
    for ($attempt = 0; $attempt -lt 2; $attempt++) {
        $app = Get-WordApp
        $document = $null
        try {
            $documents = $script:wordType.InvokeMember('Documents', $script:getProp, $null, $app, $null)
            # (FileName, ConfirmConversions, ReadOnly, AddToRecentFiles)
            $document = $documents.GetType().InvokeMember('Open', $script:invokeMethod, $null, $documents, @($path, $false, $true, $false))
            $content = $document.GetType().InvokeMember('Content', $script:getProp, $null, $document, $null)
            $text = [string]$content.GetType().InvokeMember('Text', $script:getProp, $null, $content, $null)
            $paragraphs = 0
            try {
                $collection = $document.GetType().InvokeMember('Paragraphs', $script:getProp, $null, $document, $null)
                $paragraphs = [int]$collection.GetType().InvokeMember('Count', $script:getProp, $null, $collection, $null)
            } catch { }
            try { $document.GetType().InvokeMember('Close', $script:invokeMethod, $null, $document, @($false)) | Out-Null } catch { }
            return @{ text = $text; paragraphs = $paragraphs }
        } catch {
            if ($null -ne $document) {
                try { $document.GetType().InvokeMember('Close', $script:invokeMethod, $null, $document, @($false)) | Out-Null } catch { }
            }
            Close-WordApp
            if ($attempt -eq 1) { throw }
        }
    }
    return @{ text = ''; paragraphs = 0 }
}

function Read-OcrText($bitmap) {
    try {
        $result = Await ($script:ocrEngine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        return $result.Text
    } catch {
        $converted = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert(
            $bitmap,
            [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
            [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)
        $result = Await ($script:ocrEngine.RecognizeAsync($converted)) ([Windows.Media.Ocr.OcrResult])
        return $result.Text
    }
}

function Open-StorageFile($path) {
    return Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
}

function Decode-Bitmap($stream) {
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    return Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
}

# -------------------------------------------------------------------- payload
$results = New-Object System.Collections.ArrayList

try {
    $payloadText = [System.IO.File]::ReadAllText($Job, [System.Text.Encoding]::UTF8)
    $payload = $payloadText | ConvertFrom-Json
    $jobs = @($payload.jobs)
} catch {
    $jobs = @()
    [void]$notes.Add("job file unreadable: $($_.Exception.Message)")
}

# NOTE: the loop variable must NOT be named $job — PowerShell variable names are
# case-insensitive, so it would resolve to the constrained [string]$Job parameter
# and every JSON object handed to it would be coerced into a string.
foreach ($item in $jobs) {
    $entry = [ordered]@{
        id    = [string]$item.id
        ok    = $false
        kind  = [string]$item.kind
        error = ''
        text  = ''
        pages = @()
        meta  = @{}
    }
    $path = [string]$item.path
    try {
        if (-not (Test-Path -LiteralPath $path)) { throw "file not found: $path" }
        switch ([string]$item.kind) {
            'image' {
                if (-not $capabilities.ocr) { throw 'OCR engine unavailable' }
                $file = Open-StorageFile $path
                $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
                $bitmap = Decode-Bitmap $stream
                $entry.meta = @{ width = $bitmap.PixelWidth; height = $bitmap.PixelHeight }
                $entry.text = Read-OcrText $bitmap
                $entry.ok = $true
                $stream.Dispose()
            }
            'pdf' {
                if (-not $capabilities.pdf) { throw 'PDF render/OCR unavailable' }
                $maxPages = 60
                if ($null -ne $item.maxPages) { $maxPages = [int]$item.maxPages }
                $width = 1600
                if ($null -ne $item.width -and [int]$item.width -gt 0) { $width = [int]$item.width }
                $file = Open-StorageFile $path
                $document = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
                $pageCount = [int]$document.PageCount
                $entry.meta = @{ pageCount = $pageCount; ocrWidth = $width }
                $limit = [Math]::Min($pageCount, $maxPages)
                $pageTexts = New-Object System.Collections.ArrayList
                for ($index = 0; $index -lt $limit; $index++) {
                    $page = $document.GetPage([uint32]$index)
                    $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions
                    $options.DestinationWidth = [uint32]$width
                    $memory = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
                    AwaitAction ($page.RenderToStreamAsync($memory, $options))
                    $memory.Seek(0)
                    $bitmap = Decode-Bitmap $memory
                    $text = Read-OcrText $bitmap
                    [void]$pageTexts.Add(@{ n = $index + 1; text = $text })
                    $memory.Dispose()
                    $bitmap = $null
                    $page = $null
                }
                $entry.pages = $pageTexts
                $entry.ok = $true
            }
            'doc' {
                if (-not $capabilities.word) { throw 'Word COM unavailable' }
                $read = Read-WordText $path
                $entry.text = [string]$read.text
                $entry.meta = @{ paragraphs = $read.paragraphs }
                $entry.ok = $true
            }
            default {
                throw "unsupported job kind: $($item.kind)"
            }
        }
    } catch {
        $entry.ok = $false
        $entry.error = $_.Exception.Message
    }
    [void]$results.Add($entry)
}

Close-WordApp

$capabilities.note = ($notes -join '; ')

$output = [ordered]@{
    capabilities = $capabilities
    results      = @($results)
}

try {
    $json = $output | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
    exit 0
} catch {
    $fallback = [ordered]@{ capabilities = $capabilities; results = @(); fatal = $_.Exception.Message } | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($Out, $fallback, (New-Object System.Text.UTF8Encoding($false)))
    exit 1
}
