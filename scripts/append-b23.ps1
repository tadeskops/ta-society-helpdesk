# Bundle 23: sleek KPI strip on home page (#tshKpi).
$ErrorActionPreference = 'Stop'
$cssPath = Join-Path $PSScriptRoot '..\docs\assets\css\theme.css'
$bundle = @'

/* ============================================================
   Bundle 23 — KPI strip (#tshKpi) above the Recent issues list.
   Four sleek tiles: Open / In Progress / Resolved 7d / Breaches.
   Tones (primary/info/success/danger) pull from existing CSS
   variables; the card colour-mixes a translucent accent so the
   surface stays in keeping with theme.
   ============================================================ */
.tsh-kpi-strip {
  margin: 0 0 var(--sp-5) 0;
}
.tsh-kpi-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--sp-3);
}
.tsh-kpi-card {
  position: relative;
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-areas:
    "icon  label"
    "value value"
    "delta delta";
  column-gap: var(--sp-3);
  row-gap: 4px;
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--rad-lg);
  background: var(--c-surface-1, rgba(255,255,255,0.03));
  border: 1px solid var(--c-border);
  transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
}
.tsh-kpi-card:hover {
  transform: translateY(-1px);
}

.tsh-kpi-icon {
  grid-area: icon;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--rad-pill);
  font-size: 1rem;
}
.tsh-kpi-icon--primary {
  background: color-mix(in srgb, var(--c-primary) 18%, transparent);
  color: var(--c-primary);
}
.tsh-kpi-icon--info {
  background: color-mix(in srgb, var(--c-info, #3b82f6) 18%, transparent);
  color: var(--c-info, #3b82f6);
}
.tsh-kpi-icon--success {
  background: color-mix(in srgb, var(--c-success, #16a34a) 18%, transparent);
  color: var(--c-success, #16a34a);
}
.tsh-kpi-icon--danger {
  background: color-mix(in srgb, var(--c-danger, #dc2626) 18%, transparent);
  color: var(--c-danger, #dc2626);
}

.tsh-kpi-label {
  grid-area: label;
  font-size: 0.85rem;
  color: var(--c-text-muted);
  align-self: center;
  font-weight: 500;
}
.tsh-kpi-value {
  grid-area: value;
  font-size: 1.9rem;
  font-weight: 700;
  color: var(--c-text);
  line-height: 1.1;
  margin-top: var(--sp-1);
}
.tsh-kpi-delta {
  grid-area: delta;
  font-size: 0.78rem;
  color: var(--c-text-muted);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.tsh-kpi-delta--up   { color: var(--c-success, #16a34a); }
.tsh-kpi-delta--down { color: var(--c-text-muted); }
.tsh-kpi-delta--warn { color: var(--c-danger, #dc2626); font-weight: 600; }
.tsh-kpi-delta--flat { color: var(--c-text-muted); }

/* ----- Responsive: 2x2 below 720px, single column below 380px ----- */
@media (max-width: 720px) {
  .tsh-kpi-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-2);
  }
  .tsh-kpi-card {
    padding: var(--sp-3);
  }
  .tsh-kpi-icon { width: 30px; height: 30px; font-size: 0.85rem; }
  .tsh-kpi-label { font-size: 0.78rem; }
  .tsh-kpi-value { font-size: 1.5rem; }
  .tsh-kpi-delta { font-size: 0.72rem; }
}
@media (max-width: 380px) {
  .tsh-kpi-list {
    grid-template-columns: 1fr;
  }
}
'@

$bytes = [System.IO.File]::ReadAllBytes($cssPath)
$current = [System.Text.Encoding]::UTF8.GetString($bytes)
$next = $current + $bundle
$enc = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($cssPath, $next, $enc)
Write-Host "Appended Bundle 23 ($($bundle.Length) chars)."
