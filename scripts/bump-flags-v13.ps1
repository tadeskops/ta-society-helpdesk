$ErrorActionPreference = 'Stop'
Set-Location c:\CR7\TAMC\IRP_Repo\ta-society-helpdesk\docs
$pages = 'index.html','daily-confirm.html','daily-report.html','directory.html','manage.html','manager-dashboard.html','public-board.html','settings.html'
$enc = New-Object System.Text.UTF8Encoding $false
foreach ($p in $pages) {
  $full = Join-Path (Get-Location) $p
  $bytes = [System.IO.File]::ReadAllBytes($full)
  $txt = [System.Text.Encoding]::UTF8.GetString($bytes)
  $orig = $txt
  $txt = $txt.Replace('flags.js?v=12', 'flags.js?v=13')
  if ($txt -ne $orig) {
    [System.IO.File]::WriteAllText($full, $txt, $enc)
    Write-Output "Updated $p"
  } else {
    Write-Output "No change $p"
  }
}
