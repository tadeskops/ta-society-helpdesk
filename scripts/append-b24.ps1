$ErrorActionPreference = 'Stop'
$path = 'c:\CR7\TAMC\IRP_Repo\ta-society-helpdesk\docs\assets\css\theme.css'
$enc = New-Object System.Text.UTF8Encoding $false
$bytes = [System.IO.File]::ReadAllBytes($path)
$txt = [System.Text.Encoding]::UTF8.GetString($bytes)
$bundle = @'

/* ============================================================
   Bundle 24 - Recent issues panel chrome
   #tshRecentIssues now wears the announcement-panel pattern
   (tsh-ann-panel + tsh-ann-panel-head) so it visually matches
   Announcements / Events / Polls. The inner .tsh-recent-list
   keeps its row dividers but drops its outer border + background
   because the wrapping panel already provides them.
   ============================================================ */
.tsh-recent-issues.tsh-ann-panel .tsh-recent-list {
  border: 0;
  border-radius: 0;
  background: transparent;
  overflow: visible;
  margin-top: 0;
}
.tsh-recent-issues.tsh-ann-panel .tsh-recent-more {
  margin-top: var(--sp-3);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  color: var(--c-primary);
  font-size: var(--fs-sm);
  text-decoration: none;
}
.tsh-recent-issues.tsh-ann-panel .tsh-recent-more:hover {
  text-decoration: underline;
}
'@
if ($txt -notmatch 'Bundle 24 - Recent issues panel chrome') {
  $txt = $txt.TrimEnd() + "`r`n" + $bundle + "`r`n"
  [System.IO.File]::WriteAllText($path, $txt, $enc)
  Write-Output 'Appended Bundle 24'
} else {
  Write-Output 'Bundle 24 already present'
}
