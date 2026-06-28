$ErrorActionPreference = 'Stop'
Set-Location c:\CR7\TAMC\IRP_Repo\ta-society-helpdesk\docs
$pages = Get-ChildItem -Filter *.html
$enc = New-Object System.Text.UTF8Encoding $false
foreach ($p in $pages) {
  $bytes = [System.IO.File]::ReadAllBytes($p.FullName)
  $txt = [System.Text.Encoding]::UTF8.GetString($bytes)
  $orig = $txt
  $txt = $txt.Replace('theme.css?v=49', 'theme.css?v=50')
  if ($txt -ne $orig) {
    [System.IO.File]::WriteAllText($p.FullName, $txt, $enc)
    Write-Output ("Updated " + $p.Name)
  }
}
