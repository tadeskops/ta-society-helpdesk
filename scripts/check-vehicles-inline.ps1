$path = 'C:\CR7\TAMC\IRP_Repo\ta-society-helpdesk\docs\vehicles.html'
$enc = [System.Text.UTF8Encoding]::new($false)
$html = [System.IO.File]::ReadAllText($path, $enc)
$m = [regex]::Match($html, '(?s)<script>\s*\(async \(\) => \{(.+?)\}\)\(\);\s*</script>')
if (-not $m.Success) { Write-Host 'no inline IIFE found'; exit 1 }
$body = "(async () => {`n" + $m.Groups[1].Value + "`n})();"
$tmp = Join-Path $env:TEMP '_vehicles_inline.js'
[System.IO.File]::WriteAllText($tmp, $body, $enc)
node --check $tmp
exit $LASTEXITCODE
