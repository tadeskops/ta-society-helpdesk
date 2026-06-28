# Bundle 20: revert hamburger; add tap-to-expand label for nav icons;
#            mobile hero-card icon+title on one row.
$ErrorActionPreference = 'Stop'
$cssPath = Join-Path $PSScriptRoot '..\docs\assets\css\theme.css'
$bundle = @'

/* ============================================================
   Bundle 20 — mobile nav: tap-to-expand label (no hamburger);
   hero track-card icon + title on one row.
   ============================================================ */

/* ----- Tap-to-expand label on phones (<=480px) --------------------------
   Bundle 15 collapses nav links + userbox buttons to icon-only via
   `font-size: 0` so the labels visually vanish. When ui.js#IconLabel adds
   `.is-expanded` on tap, we re-show the label inline and animate the chip
   width. `.expand-left` flips the content order so chips near the right
   edge grow leftward instead of clipping the viewport. */
@media (max-width: 480px) {
  .tsh-nav a,
  .tsh-userbox [data-tsh-signin],
  .tsh-userbox [data-tsh-signout] {
    transition: padding 180ms ease, background 160ms ease, color 160ms ease,
                border-color 160ms ease, gap 180ms ease, max-width 200ms ease;
  }

  .tsh-nav a.is-expanded,
  .tsh-userbox [data-tsh-signin].is-expanded,
  .tsh-userbox [data-tsh-signout].is-expanded {
    font-size: 0.85rem;
    gap: 7px;
    padding: 7px 11px;
    background: color-mix(in srgb, var(--c-primary) 18%, transparent);
    border-color: color-mix(in srgb, var(--c-primary) 45%, var(--c-border-soft, transparent));
    color: var(--c-primary);
  }
  .tsh-nav a.is-expanded > span,
  .tsh-nav a.is-expanded [data-tsh-myreports-count],
  .tsh-userbox .is-expanded .tsh-btn-label {
    position: static;
    width: auto;
    height: auto;
    clip: auto;
    overflow: visible;
    white-space: nowrap;
    margin: 0;
  }
  /* Smart-anchor: chips that would clip the right edge grow leftward. */
  .tsh-nav a.is-expanded.expand-left,
  .tsh-userbox [data-tsh-signin].is-expanded.expand-left,
  .tsh-userbox [data-tsh-signout].is-expanded.expand-left {
    flex-direction: row-reverse;
  }
}

/* ----- Hero track-card: icon + title on one row (<=720px) ---------------
   Default card layout stacks icon, h2, p, cta vertically. On tablets and
   phones we switch to a 2-col grid: row 1 = [icon | title], row 2 = body,
   row 3 = CTA. Keeps the card tappable and visually denser. */
@media (max-width: 720px) {
  .tsh-track-card {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: var(--sp-3);
    row-gap: var(--sp-2);
    align-items: center;
    padding: var(--sp-4);
  }
  .tsh-track-card .tsh-track-icon {
    grid-row: 1;
    grid-column: 1;
    width: 40px;
    height: 40px;
    font-size: 1.25rem;
  }
  .tsh-track-card h2 {
    grid-row: 1;
    grid-column: 2;
    font-size: var(--fs-lg);
    margin: 0;
    line-height: 1.25;
  }
  .tsh-track-card p {
    grid-row: 2;
    grid-column: 1 / -1;
    margin: 0;
    flex: none;
  }
  .tsh-track-card .tsh-cta {
    grid-row: 3;
    grid-column: 1 / -1;
    margin-top: 0;
  }
}
'@

$bytes = [System.IO.File]::ReadAllBytes($cssPath)
$current = [System.Text.Encoding]::UTF8.GetString($bytes)
$next = $current + $bundle
$enc = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($cssPath, $next, $enc)
Write-Host "Appended Bundle 20 ($($bundle.Length) chars)."
