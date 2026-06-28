# Bundle 21: per-card collapse for hero track cards.
$ErrorActionPreference = 'Stop'
$cssPath = Join-Path $PSScriptRoot '..\docs\assets\css\theme.css'
$bundle = @'

/* ============================================================
   Bundle 21 — per-card collapse for .tsh-track-card on mobile.
   Chevron injected by ui.js#CardCollapse. Desktop hides chevron
   and ignores the collapse state — cards always render fully.
   ============================================================ */
.tsh-card-collapse { display: none; }

@media (max-width: 720px) {
  .tsh-track-card { position: relative; padding-right: var(--sp-8); }
  .tsh-card-collapse {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    position: absolute;
    top: 10px;
    right: 10px;
    width: 30px;
    height: 30px;
    padding: 0;
    border: 1px solid var(--c-border-soft, transparent);
    background: transparent;
    color: var(--c-text-muted);
    border-radius: var(--rad-pill);
    cursor: pointer;
    z-index: 2;
    transition: background 160ms ease, color 160ms ease,
                border-color 160ms ease, transform 200ms ease;
  }
  .tsh-card-collapse:hover,
  .tsh-card-collapse:focus-visible {
    background: var(--c-surface-2);
    color: var(--c-primary);
    border-color: color-mix(in srgb, var(--c-primary) 35%, var(--c-border-soft, transparent));
    outline: none;
  }
  .tsh-card-collapse i {
    font-size: 0.85rem;
    transition: transform 200ms ease;
  }
  .tsh-track-card.is-collapsed .tsh-card-collapse i { transform: rotate(180deg); }

  /* Collapsed state: hide body + CTA, keep icon + title visible. */
  .tsh-track-card.is-collapsed > p,
  .tsh-track-card.is-collapsed > .tsh-cta { display: none; }
  .tsh-track-card.is-collapsed { row-gap: 0; }
}
'@

$bytes = [System.IO.File]::ReadAllBytes($cssPath)
$current = [System.Text.Encoding]::UTF8.GetString($bytes)
$next = $current + $bundle
$enc = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($cssPath, $next, $enc)
Write-Host "Appended Bundle 21 ($($bundle.Length) chars)."
