# The Address Logo References

## Overview
All pages have been updated to use **The Address** official logos instead of generic icons.

## Logo Files in Use

### 1. **TaLogo.png** (Logo Only - Recommended for navigation)
- **Purpose**: Compact logo for navigation headers and compact spaces
- **Size**: Square format
- **Usage**: Small profile in all dashboard/navigation bars
- **Current Implementation**: Used in submitted-issues, committee-dashboard, builder-dashboard, dashboard
- **Location**: `assets/images/TaLogo.png`

### 2. **TaLogoName.png** (Logo + Name - For branding)
- **Purpose**: Full branding with "THE ADDRESS" text
- **Size**: Landscape format
- **Usage**: Login page, large branding areas
- **Current Implementation**: Used in index.html login page
- **Location**: `assets/images/TaLogoName.png`

### 3. **TaName.png** (Text only - For reference)
- **Purpose**: Text-only version for reference/documentation
- **Location**: `assets/images/TaName.png`

## Current Implementation

### Default: Logo-Only Style (Navigation - All Dashboards)
```html
<img src="assets/images/TaLogo.png" alt="The Address" class="h-12 w-12 drop-shadow-lg">
```
✅ Used in:
- submitted-issues.html
- committee-dashboard.html
- builder-dashboard.html
- dashboard.html

### Logo + Text Style (Login Page)
```html
<img src="assets/images/TaLogoName.png" alt="The Address" class="h-20 mx-auto drop-shadow-lg">
```
✅ Used in: index.html (primary branding)

## How to Switch Between Styles

### To use Logo+Text on any dashboard:
1. Find the logo section (in navbar)
2. Comment out the logo-only line:
   ```html
   <!-- <img src="assets/images/TaLogo.png" ...> -->
   ```
3. Uncomment the alternative:
   ```html
   <div><img src="assets/images/TaLogoName.png" ...></div>
   ```

## Files Updated
- ✅ `index.html` - Login page (uses TaLogoName.png)
- ✅ `submitted-issues.html` - View submitted issues (uses TaLogo.png)
- ✅ `committee-dashboard.html` - Committee dashboard (uses TaLogo.png)
- ✅ `builder-dashboard.html` - Builder/executor dashboard (uses TaLogo.png)
- ✅ `dashboard.html` - Analytics dashboard (uses TaLogo.png)

## Logo Sizing Reference
- **Navigation bars**: `h-12 w-12` (48x48px display)
- **Login page header**: `h-20` (80px display height)
- **Can be adjusted** with `h-16`, `h-14`, `h-10` Tailwind classes

## Design Notes
- All logos use `drop-shadow-lg` for visual depth
- Responsive sizing with Tailwind classes
- Works with both light and dark backgrounds
- Maintains brand consistency across all interfaces

## Git Workflow
```bash
git add assets/images/
git add *.html
git commit -m "Update: Use official The Address logos (TaLogo, TaLogoName, TaName)"
git push
```
