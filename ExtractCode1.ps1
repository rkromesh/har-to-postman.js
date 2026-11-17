# ============================================================
# Export Open Visual Studio Files To Consolidated Text Files
# VS 2026 (DTE 18.0)
#
# Output:
#   PM-123456_yyyyMMdd_HHmmss
#       csharp.txt
#       typescript.txt
#       htmlcontent.txt
#       cshtmlcontent.txt
#
# No source files are copied.
# ============================================================

Clear-Host

# ------------------------------------------------------------
# Ticket Number
# ------------------------------------------------------------

$ticketNumber = Read-Host "Enter Work Item / Ticket Number (Example: PM-123456)"

if ([string]::IsNullOrWhiteSpace($ticketNumber))
{
    Write-Error "Ticket Number cannot be empty."
    exit 1
}

# ------------------------------------------------------------
# Create Destination Folder
# ------------------------------------------------------------

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"

$destinationFolder = Join-Path `
    -Path (Get-Location).Path `
    -ChildPath "${ticketNumber}_${timestamp}"

New-Item `
    -ItemType Directory `
    -Path $destinationFolder `
    -Force | Out-Null

Write-Host ""
Write-Host "Destination Folder Created:" -ForegroundColor Cyan
Write-Host $destinationFolder -ForegroundColor Green
Write-Host ""

# ------------------------------------------------------------
# Consolidated Output Files
# ------------------------------------------------------------

$csharpFile     = Join-Path $destinationFolder "csharp.txt"
$typescriptFile = Join-Path $destinationFolder "typescript.txt"
$htmlFile       = Join-Path $destinationFolder "htmlcontent.txt"
$cshtmlFile     = Join-Path $destinationFolder "cshtmlcontent.txt"

New-Item -ItemType File -Path $csharpFile -Force | Out-Null
New-Item -ItemType File -Path $typescriptFile -Force | Out-Null
New-Item -ItemType File -Path $htmlFile -Force | Out-Null
New-Item -ItemType File -Path $cshtmlFile -Force | Out-Null

# ------------------------------------------------------------
# Connect To Visual Studio
# ------------------------------------------------------------

try
{
    $dte = [System.Runtime.InteropServices.Marshal]::GetActiveObject(
        "VisualStudio.DTE.18.0"
    )

    Write-Host "Connected to Visual Studio." -ForegroundColor Green
}
catch
{
    Write-Error "Unable to connect to Visual Studio 2026."
    Write-Error "Ensure Visual Studio 2026 is running."
    exit 1
}

# ------------------------------------------------------------
# Verify Open Documents
# ------------------------------------------------------------

if ($dte.Documents.Count -eq 0)
{
    Write-Warning "No open documents found."
    exit 0
}

Write-Host "Open Documents Found: $($dte.Documents.Count)"
Write-Host ""

# ------------------------------------------------------------
# Tracking
# ------------------------------------------------------------

$processedFiles = [System.Collections.Generic.HashSet[string]]::new()

$csCount = 0
$tsCount = 0
$htmlCount = 0
$cshtmlCount = 0

# ------------------------------------------------------------
# Process Documents
# ------------------------------------------------------------

foreach ($doc in $dte.Documents)
{
    try
    {
        $sourcePath = $doc.FullName

        if ([string]::IsNullOrWhiteSpace($sourcePath))
        {
            continue
        }

        if (-not (Test-Path -LiteralPath $sourcePath))
        {
            Write-Warning "Skipped (Not Saved): $($doc.Name)"
            continue
        }

        if ($processedFiles.Contains($sourcePath))
        {
            continue
        }

        $processedFiles.Add($sourcePath) | Out-Null

        $extension = [System.IO.Path]::GetExtension(
            $sourcePath
        ).ToLowerInvariant()

        if ($extension -notin @(
            ".cs",
            ".ts",
            ".html",
            ".cshtml"
        ))
        {
            continue
        }

        Write-Host "Processed: $($doc.Name)" -ForegroundColor Green

        $content = Get-Content `
            -LiteralPath $sourcePath `
            -Raw `
            -ErrorAction Stop

        switch ($extension)
        {
            ".cs"
            {
                $csCount++

@"
================================================================================
FILE: $sourcePath
================================================================================

$content


"@ | Add-Content -Path $csharpFile
            }

            ".ts"
            {
                $tsCount++

@"
================================================================================
FILE: $sourcePath
================================================================================

$content


"@ | Add-Content -Path $typescriptFile
            }

            ".html"
            {
                $htmlCount++

@"
================================================================================
FILE: $sourcePath
================================================================================

$content


"@ | Add-Content -Path $htmlFile
            }

            ".cshtml"
            {
                $cshtmlCount++

@"
================================================================================
FILE: $sourcePath
================================================================================

$content


"@ | Add-Content -Path $cshtmlFile
            }
        }
    }
    catch
    {
        Write-Warning "Failed Processing: $($doc.Name)"
        Write-Warning $_.Exception.Message
    }
}

# ------------------------------------------------------------
# Summary
# ------------------------------------------------------------

$totalFiles = $csCount + $tsCount + $htmlCount + $cshtmlCount

Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "EXPORT COMPLETED" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor 

Write-Host "Output Folder:" -ForegroundColor Yellow
Write-Host $destinationFolder
Write-Host ""

Write-Host "Statistics:" -ForegroundColor Yellow
Write-Host "  C# Files      : $csCount"
Write-Host "  TS Files      : $tsCount"
Write-Host "  HTML Files    : $htmlCount"
Write-Host "  CSHTML Files  : $cshtmlCount"
Write-Host "  Total Files   : $totalFiles"
Write-Host ""

Write-Host "Generated Files:" -ForegroundColor Yellow
Write-Host "  csharp.txt"
Write-Host "  typescript.txt"
Write-Host "  htmlcontent.txt"
Write-Host "  cshtmlcontent.txt"
Write-Host ""

Get-ChildItem $destinationFolder -File |
    Sort-Object Name |
    Select-Object `
        Name,
        @{
            Name = "SizeKB"
            Expression = {
                :Round($_.Length / 1KB, 2)
            }
        } |
    Format-Table -AutoSize

Write-Host ""
Write-Host "Done." -ForegroundColor Green