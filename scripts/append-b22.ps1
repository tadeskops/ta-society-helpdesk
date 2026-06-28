# Bundle 22: sleek "Recent issues" preview list for the home page.
$ErrorActionPreference = 'Stop'
$cssPath = Join-Path $PSScriptRoot '..\docs\assets\css\theme.css'
$bundle = @'

/* ============================================================
   Bundle 22 — Recent issues preview (#tshRecentIssues) on home.
   Brief, sleek one-line-per-item list. Full triage UI lives on
   /manage and /public-board; this is just an at-a-glance peek.
   ============================================================ */
.tsh-recent-issues {
  margin-bottom: var(--sp-6);
}
.tsh-recent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--c-border);
  border-radius: var(--rad-lg);
  background: var(--c-surface-1, rgba(255,255,255,0.03));
  overflow: hidden;
}
.tsh-recent-item + .tsh-recent-item {
  border-top: 1px solid var(--c-border);
}
.tsh-recent-link {
  display: grid;
  grid-template-columns: auto auto 1fr auto;
  grid-template-areas: "status id title age" ".      .  meta  meta";
  column-gap: var(--sp-3);
  row-gap: 2px;
  align-items: center;
  padding: var(--sp-3) var(--sp-4);
  color: var(--c-text);
  text-decoration: none;
  transition: background 160ms ease;
}
.tsh-recent-link:hover,
.tsh-recent-link:focus-visible {
  background: var(--c-surface-2);
  text-decoration: none;
  outline: none;
}
.tsh-recent-link > .tsh-pill { grid-area: status; }
.tsh-recent-id    { grid-area: id; font-size: 0.78rem; color: var(--c-text-muted); }
.tsh-recent-title { grid-area: title;
                    font-weight: 500;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis; }
.tsh-recent-age   { grid-area: age; font-size: 0.78rem; color: var(--c-text-muted); white-space: nowrap; }
.tsh-recent-meta  { grid-area: meta; font-size: 0.78rem; color: var(--c-text-muted); }

.tsh-recent-more {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: var(--sp-3);
  color: var(--c-primary);
  font-weight: 600;
  text-decoration: none;
}
.tsh-recent-more:hover,
.tsh-recent-more:focus-visible {
  text-decoration: underline;
  outline: none;
}

@media (max-width: 480px) {
  .tsh-recent-link {
    column-gap: var(--sp-2);
    padding: var(--sp-3);
    grid-template-columns: auto 1fr auto;
    grid-template-areas: "status title age" "id     meta  meta";
  }
  .tsh-recent-title { font-size: 0.92rem; }
}
'@

$bytes = [System.IO.File]::ReadAllBytes($cssPath)
$current = [System.Text.Encoding]::UTF8.GetString($bytes)
$next = $current + $bundle
$enc = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($cssPath, $next, $enc)
Write-Host "Appended Bundle 22 ($($bundle.Length) chars)."
