# Google Apps Script Backend

This folder contains the zero-infrastructure backend for the Grit Compliance Complaint Classifier.

## Deploy

1. Open the existing Apps Script project associated with the Grit compliance web app.
2. Replace the existing `Code.gs` contents with the contents of this repository's `apps-script/Code.gs`.
3. Save.
4. Choose **Deploy -> Manage deployments**.
5. Edit the existing Web App deployment or create a new version.
6. Recommended:
   - Execute as: **User accessing the web app**
   - Access: **Users in gritfinancial.org** (or the most restrictive Grit Workspace option available)
7. Deploy and authorize Google Sheets access when prompted.

## Test

Open the Web App URL with:

`?action=health`

A successful response contains:

`{"status":"ok", ...}`

For the GitHub Pages UI, analysis uses JSONP:

`?action=analyze&sheet_url=<encoded Google Sheet URL>&callback=<callback>`

Each Google Sheets URL is treated as a **workbook**. The backend scans every tab in that workbook and analyzes each tab that contains a recognizable complaint column. Empty tabs and non-complaint tabs are skipped and reported in metadata.

The frontend accepts up to **10 Google Sheets files at once**, one URL per line. It analyzes each workbook and combines the results into one dashboard and one Excel export.

The POST endpoint also accepts `sheet_urls` as an array for multi-file processing.

This avoids cross-origin browser restrictions between GitHub Pages and Apps Script.

## Input sheet

The backend automatically looks for these column concepts:

- Complaint / Reason / Description / Narrative / Issue **(required)**
- Resolution / Response / Outcome / Action Taken
- Case ID / Ticket / Complaint ID
- Date
- Customer / Employee Name
- Program / Product / Client
- Source / Channel / Method

## Confidence governance

- **80-100%:** standard automated triage
- **50-79.9%:** Needs Human Review
- **Below 50%:** Unknown / Insufficient Evidence + Human Review

The output is preliminary compliance triage. Final determinations remain subject to human Compliance or Legal review.


## Workbook and multi-file limits

- Up to 5,000 rows per tab
- Up to 15,000 rows per workbook
- Up to 10 Google Sheets files in a multi-file request
- All tabs are scanned; only tabs with a recognizable complaint column are classified
- Source spreadsheet and source tab are retained on every result row
