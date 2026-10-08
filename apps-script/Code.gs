/**
 * Grit Compliance Complaint Classifier - Google Apps Script Backend
 *
 * Deploy as a Web App in the Grit Google Workspace domain.
 * Recommended deployment:
 *   Execute as: User accessing the web app
 *   Who has access: Anyone within gritfinancial.org (or the most restrictive domain option available)
 *
 * Supports:
 *   GET  ?action=health
 *   GET  ?action=analyze&sheet_url=...&callback=...
 *   POST {"action":"analyze","sheet_url":"..."}
 *
 * The GET + callback form is JSONP-compatible and is the most reliable path
 * for GitHub Pages because it avoids browser CORS restrictions.
 */

const CONFIG = Object.freeze({
  RULE_VERSION: '2026.10-apps-script.1',
  REVIEW_THRESHOLD: 80,
  UNKNOWN_THRESHOLD: 50,
  MAX_ROWS_PER_TAB: 5000,
  MAX_TOTAL_ROWS: 15000,
  MAX_FILES_PER_REQUEST: 10
});

const REGULATIONS = Object.freeze({
  UDAAP: {
    strong: [
      'mislead','misleading','not disclosed','undisclosed','deceptive',
      'unable to access','cannot access','unexpected fee','promised',
      'without consent','no notice'
    ],
    medium: [
      'confus','fee','locked','frozen','declin','limit','delay',
      'missing funds','charged','unable to use','cannot use'
    ]
  },
  'Reg E': {
    strong: [
      'unauthorized','did not authorize','not authorized','dispute',
      'missing funds','atm','debit card','ach','electronic transfer',
      'provisional credit','error resolution'
    ],
    medium: [
      'transfer','withdraw','withdrawal','card','reversal','transaction',
      'deposit','refund'
    ]
  },
  'Reg DD': {
    strong: [
      'apy','annual percentage yield','deposit disclosure','interest rate',
      'truth in savings'
    ],
    medium: [
      'deposit account','balance requirement','account fee','interest'
    ]
  },
  'Reg P': {
    strong: [
      'privacy','personal information','nonpublic personal information',
      'shared my data','data shared','privacy notice'
    ],
    medium: [
      'third party','information disclosed','personal data','data'
    ]
  },
  'Reg GG': {
    strong: ['gambling','wager','betting','casino','unlawful internet gambling'],
    medium: ['restricted transaction']
  }
});

const ISSUE_CATEGORIES = Object.freeze({
  'Account Opening Issue': ['open account','onboarding','identity verification','kyc','registration'],
  'Account Restriction': ['locked','frozen','restricted','suspended','disabled','blocked'],
  'Customer Service': ['customer service','support','no response','callback','follow up','follow-up'],
  'Deposit/Withdrawal Issue': ['deposit','withdraw','withdrawal','missing funds','bank transfer'],
  'Fees': ['fee','charge','charged'],
  'Unresolved Fraud Non-ID Theft': ['unauthorized','fraud','not mine','did not authorize','dispute'],
  'Unresolved ID Theft': ['identity theft','stolen identity'],
  'Interest': ['apy','interest','yield'],
  'Limits': ['limit','maximum','cap','exceeded'],
  'Marketing/Advertising': ['advertis','promotion','promised','marketing','misleading'],
  'Return of Funds': ['refund','reversal','reversed','credited back'],
  'Statement Issue': ['statement','transaction history'],
  'Technical': ['bug','error','app','system','crash','technical','failed']
});

const ROOT_CAUSES = Object.freeze({
  'EWA Availability / Limit Issue': [
    'ewa','earned wage','available wage','accrued wage','repayment','limit'
  ],
  'Identity / KYC Verification Issue': [
    'kyc','identity','verify','verification','phone number','address verification'
  ],
  'Onboarding / Account Setup Issue': [
    'onboard','registration','sign up','signup','account opening'
  ],
  'Deposit / Withdrawal / Return of Funds Issue': [
    'deposit','withdraw','withdrawal','refund','reversal','bank transfer','funds'
  ],
  'System / Technical Issue': [
    'technical','system','bug','app','failed','error'
  ],
  'Card / ATM / Transaction Decline Issue': [
    'card','atm','declined','pin','merchant','fraud detection'
  ],
  'Customer Education / Disclosure Clarity Issue': [
    'explained','informed','advised','fee','policy','confus','disclosure'
  ],
  'Unauthorized Transaction / Dispute Issue': [
    'unauthorized','dispute','fraud','not mine'
  ]
});

function doGet(e) {
  const p = (e && e.parameter) || {};
  const action = String(p.action || 'health').toLowerCase();

  if (action === 'health') {
    return respond_({
      status: 'ok',
      service: 'Grit Compliance Classifier',
      rule_version: CONFIG.RULE_VERSION,
      review_threshold: CONFIG.REVIEW_THRESHOLD,
      unknown_threshold: CONFIG.UNKNOWN_THRESHOLD,
      timestamp: new Date().toISOString()
    }, p.callback);
  }

  if (action === 'analyze') {
    try {
      const sheetUrl = p.sheet_url || p.sheetUrl || '';
      const result = analyzeWorkbook_(sheetUrl);
      return respond_(result, p.callback);
    } catch (err) {
      return respond_({status:'error', error: err.message || String(err)}, p.callback);
    }
  }

  return respond_({status:'error', error:'Unsupported action.'}, p.callback);
}

function doPost(e) {
  try {
    const body = parseBody_(e);
    const action = String(body.action || 'analyze').toLowerCase();

    if (action === 'health') {
      return respond_({
        status: 'ok',
        service: 'Grit Compliance Classifier',
        rule_version: CONFIG.RULE_VERSION,
        timestamp: new Date().toISOString()
      });
    }

    if (action !== 'analyze') {
      throw new Error('Unsupported action.');
    }

    const sheetUrls = body.sheet_urls || body.sheetUrls || [];
    if (Array.isArray(sheetUrls) && sheetUrls.length) {
      return respond_(analyzeFiles_(sheetUrls));
    }

    const sheetUrl = body.sheet_url || body.sheetUrl || '';
    return respond_(analyzeWorkbook_(sheetUrl));
  } catch (err) {
    return respond_({status:'error', error: err.message || String(err)});
  }
}

function analyzeFiles_(sheetUrls) {
  const urls = unique_(
    (sheetUrls || [])
      .map(v => String(v || '').trim())
      .filter(Boolean)
  );

  if (!urls.length) throw new Error('At least one Google Sheets URL is required.');
  if (urls.length > CONFIG.MAX_FILES_PER_REQUEST) {
    throw new Error('A maximum of ' + CONFIG.MAX_FILES_PER_REQUEST + ' Google Sheets files can be analyzed in one request.');
  }

  const files = [];
  const results = [];
  const errors = [];

  urls.forEach(url => {
    try {
      const fileResult = analyzeWorkbook_(url);
      files.push({
        spreadsheet_name: fileResult.spreadsheet_name,
        spreadsheet_id: fileResult.spreadsheet_id,
        tabs_analyzed: fileResult.tabs_analyzed,
        tabs_skipped: fileResult.tabs_skipped,
        rows_classified: fileResult.rows_classified
      });
      Array.prototype.push.apply(results, fileResult.results);
    } catch (err) {
      errors.push({sheet_url:url, error:err.message || String(err)});
    }
  });

  if (!results.length && errors.length) {
    throw new Error('No files could be analyzed. ' + errors.map(e => e.error).join(' | '));
  }

  return {
    status: errors.length ? 'partial_success' : 'success',
    files_requested: urls.length,
    files_analyzed: files.length,
    files_failed: errors.length,
    tabs_analyzed: files.reduce((n, f) => n + Number(f.tabs_analyzed || 0), 0),
    rows_classified: results.length,
    file_results: files,
    errors: errors,
    rule_version: CONFIG.RULE_VERSION,
    generated_at: new Date().toISOString(),
    summary: summarize_(results),
    results: results
  };
}

function analyzeWorkbook_(sheetUrl) {
  if (!sheetUrl) {
    throw new Error('A Google Sheets URL is required.');
  }

  const parsed = parseSheetUrl_(sheetUrl);
  const ss = SpreadsheetApp.openById(parsed.spreadsheetId);
  const sheets = ss.getSheets();
  const results = [];
  const analyzedTabs = [];
  const skippedTabs = [];
  let totalRowsScanned = 0;

  for (let s = 0; s < sheets.length; s++) {
    const sheet = sheets[s];

    if (totalRowsScanned >= CONFIG.MAX_TOTAL_ROWS) {
      skippedTabs.push({
        sheet_name: sheet.getName(),
        reason: 'Workbook row limit reached'
      });
      continue;
    }

    const values = sheet.getDataRange().getDisplayValues();

    if (!values || values.length < 2) {
      skippedTabs.push({
        sheet_name: sheet.getName(),
        reason: 'No data rows'
      });
      continue;
    }

    const headers = values[0].map(v => String(v || '').trim());
    const mapping = inferColumns_(headers);

    if (mapping.complaint === -1) {
      skippedTabs.push({
        sheet_name: sheet.getName(),
        reason: 'No recognizable complaint/reason/description/narrative/issue column'
      });
      continue;
    }

    const availableRows = values.length - 1;
    const remainingRows = CONFIG.MAX_TOTAL_ROWS - totalRowsScanned;
    const rowLimit = Math.min(availableRows, CONFIG.MAX_ROWS_PER_TAB, remainingRows);
    let classifiedOnTab = 0;

    for (let i = 1; i <= rowLimit; i++) {
      const row = values[i];
      if (isBlankRow_(row)) continue;

      const rec = {
        row_number: i + 1,
        case_id: valueAt_(row, mapping.case_id) || sheet.getName() + '-ROW-' + (i + 1),
        customer: valueAt_(row, mapping.customer),
        date: valueAt_(row, mapping.date),
        program_product: valueAt_(row, mapping.program),
        source_channel: valueAt_(row, mapping.source),
        complaint: valueAt_(row, mapping.complaint),
        resolution: valueAt_(row, mapping.resolution),
        source_sheet: sheet.getName(),
        source_spreadsheet: ss.getName(),
        source_spreadsheet_id: ss.getId()
      };

      if (!rec.complaint && !rec.resolution) continue;
      results.push(classifyComplaint_(rec));
      classifiedOnTab++;
    }

    totalRowsScanned += rowLimit;
    analyzedTabs.push({
      sheet_name: sheet.getName(),
      rows_scanned: rowLimit,
      rows_classified: classifiedOnTab
    });
  }

  if (!results.length) {
    const details = skippedTabs.length
      ? ' Tabs skipped: ' + skippedTabs.map(t => t.sheet_name + ' (' + t.reason + ')').join('; ')
      : '';
    throw new Error('No complaint rows were found in any tab of this Google Sheet.' + details);
  }

  return {
    status: 'success',
    spreadsheet_name: ss.getName(),
    spreadsheet_id: ss.getId(),
    tabs_total: sheets.length,
    tabs_analyzed: analyzedTabs.length,
    tabs_skipped: skippedTabs.length,
    analyzed_tabs: analyzedTabs,
    skipped_tabs: skippedTabs,
    rows_scanned: totalRowsScanned,
    rows_classified: results.length,
    rule_version: CONFIG.RULE_VERSION,
    generated_at: new Date().toISOString(),
    summary: summarize_(results),
    results: results
  };
}

function classifyComplaint_(rec) {
  const complaint = String(rec.complaint || '');
  const resolution = String(rec.resolution || '');
  const text = (complaint + ' ' + resolution).toLowerCase();

  const scores = {};
  const hits = {};

  Object.keys(REGULATIONS).forEach(reg => {
    const r = scoreRegulation_(text, REGULATIONS[reg]);
    scores[reg] = r.score;
    hits[reg] = r.hits;
  });

  const potential = Object.keys(scores).filter(reg => scores[reg] >= 65);
  const topScore = Math.max.apply(null, Object.keys(scores).map(k => scores[k]));

  let confidence;
  let proposed;

  if (potential.length) {
    confidence = Math.max(topScore, Math.min(96, 70 + (4 * potential.length)));
    proposed = potential.join(' + ');
  } else {
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    confidence = words >= 18 ? 82 : words >= 8 ? 58 : 35;
    proposed = 'Operational / No Clear Regulatory Indicator';
  }

  let primary;
  let review;

  if (confidence < CONFIG.UNKNOWN_THRESHOLD) {
    primary = 'Unknown / Insufficient Evidence';
    review = 'Yes';
  } else if (confidence < CONFIG.REVIEW_THRESHOLD) {
    primary = 'Needs Human Review';
    review = 'Yes';
  } else {
    primary = proposed;
    review = 'No';
  }

  const severity = calculateSeverity_(text);
  const likelihood = topScore >= 90 ? 3 : topScore >= 75 ? 2 : topScore >= 60 ? 1 : 0;
  const priority = severity >= 4 && likelihood >= 2
    ? 'High'
    : (severity >= 3 || review === 'Yes' ? 'Medium' : 'Standard');

  const triggerText = [];
  potential.forEach(reg => {
    const uniqueHits = unique_(hits[reg]).slice(0, 4);
    if (uniqueHits.length) triggerText.push(reg + ': ' + uniqueHits.join(', '));
  });
  if (!triggerText.length) {
    triggerText.push('No clear regulatory trigger identified from the available narrative');
  }

  const missing = [];
  if (potential.indexOf('Reg E') >= 0) {
    if (text.indexOf('$') === -1) missing.push('transaction amount');
    if (!containsAny_(text, ['unauthorized','authorize','fraud','dispute'])) {
      missing.push('authorization status');
    }
    if (!containsAny_(text, ['date','today','yesterday','posted','pending'])) {
      missing.push('transaction chronology');
    }
  }

  if (potential.indexOf('UDAAP') >= 0 &&
      !containsAny_(text, ['disclos','explain','inform','promis','mislead','notice'])) {
    missing.push('relevant disclosure or customer communication');
  }

  const rationale = [];
  potential.forEach(reg => {
    rationale.push(reg + ' indicator supported by complaint facts and rule triggers; confirm applicability against the complete complaint record.');
  });

  if (!rationale.length) {
    rationale.push('No clear UDAAP, Regulation E, Regulation DD, Regulation P, or Regulation GG trigger was identified from the available complaint narrative.');
  }

  if (review === 'Yes') {
    rationale.push(
      confidence < CONFIG.UNKNOWN_THRESHOLD
        ? 'Human review is required because confidence is below 50% and the case is classified as Unknown / Insufficient Evidence.'
        : 'Human review is required because classification confidence is below 80%.'
    );
  }

  return Object.assign({}, rec, {
    issue_category: pickLabel_(text, ISSUE_CATEGORIES, 'Other'),
    root_cause_category: pickLabel_(text, ROOT_CAUSES, 'Unable to Determine from Complaint Log'),
    udaap: potential.indexOf('UDAAP') >= 0 ? 'Yes' : 'No',
    reg_e: potential.indexOf('Reg E') >= 0 ? 'Yes' : 'No',
    reg_dd: potential.indexOf('Reg DD') >= 0 ? 'Yes' : 'No',
    reg_p: potential.indexOf('Reg P') >= 0 ? 'Yes' : 'No',
    reg_gg: potential.indexOf('Reg GG') >= 0 ? 'Yes' : 'No',
    potential_regulations: potential.length ? potential.join(', ') : 'None identified',
    proposed_classification: proposed,
    primary_classification: primary,
    confidence: Math.round(confidence * 10) / 10,
    needs_human_review: review,
    triggering_facts: triggerText.join('; '),
    missing_facts: missing.length ? unique_(missing).join(', ') : 'None identified from current rule set',
    regulatory_likelihood: likelihood,
    consumer_impact_severity: severity,
    priority: priority,
    recommended_action: review === 'Yes'
      ? 'Compliance review required'
      : (priority === 'High' ? 'Compliance review recommended' : 'Standard compliance triage'),
    regulatory_rationale: rationale.join(' '),
    classification_basis: 'Deterministic regulatory rules + contextual heuristics',
    rule_version: CONFIG.RULE_VERSION
  });
}

function scoreRegulation_(text, cfg) {
  const strong = cfg.strong.filter(term => text.indexOf(term) >= 0);
  const medium = cfg.medium.filter(term => text.indexOf(term) >= 0);

  let score = 0;
  if (strong.length) {
    score = Math.min(98, 76 + (9 * strong.length) + Math.min(6, 3 * medium.length));
  } else if (medium.length) {
    score = Math.min(86, 55 + (8 * medium.length));
  }

  return {score: score, hits: strong.concat(medium)};
}

function calculateSeverity_(text) {
  if (containsAny_(text, ['unauthorized','fraud','identity theft','missing funds'])) return 5;
  if (containsAny_(text, ['locked','frozen','cannot access','unable to access','refund','reversal'])) return 4;
  if (containsAny_(text, ['fee','declined','limit','delay'])) return 3;
  return text.trim().split(/\s+/).length > 10 ? 2 : 1;
}

function summarize_(rows) {
  const n = rows.length;
  return {
    total_cases: n,
    needs_human_review: rows.filter(r => r.needs_human_review === 'Yes').length,
    average_confidence: n
      ? Math.round((rows.reduce((a, r) => a + Number(r.confidence || 0), 0) / n) * 10) / 10
      : 0,
    udaap_flags: rows.filter(r => r.udaap === 'Yes').length,
    reg_e_flags: rows.filter(r => r.reg_e === 'Yes').length,
    reg_dd_flags: rows.filter(r => r.reg_dd === 'Yes').length,
    reg_p_flags: rows.filter(r => r.reg_p === 'Yes').length,
    reg_gg_flags: rows.filter(r => r.reg_gg === 'Yes').length,
    unknown: rows.filter(r => r.primary_classification === 'Unknown / Insufficient Evidence').length,
    high_priority: rows.filter(r => r.priority === 'High').length
  };
}

function inferColumns_(headers) {
  const normalized = headers.map(h => normalizeHeader_(h));

  function pick(candidates) {
    for (let c = 0; c < candidates.length; c++) {
      const target = normalizeHeader_(candidates[c]);
      for (let i = 0; i < normalized.length; i++) {
        if (normalized[i] === target || normalized[i].indexOf(target) >= 0) return i;
      }
    }
    return -1;
  }

  return {
    complaint: pick(['complaint reason','complaint','reason','description','narrative','issue']),
    resolution: pick(['resolution provided','resolution','response','outcome','action taken']),
    case_id: pick(['complainant identifier','complainant id','case id','ticket','complaint id','ticket id']),
    date: pick(['date complaint received','complaint date','date','created']),
    customer: pick(['name of complainant','complainant name','customer name','employee name','customer','name']),
    program: pick(['program name','program','complaint product','product','client']),
    source: pick(['method complaint received','source','channel','method'])
  };
}

function parseSheetUrl_(url) {
  const match = String(url).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) throw new Error('Please provide a valid Google Sheets URL.');

  const gidMatch = String(url).match(/[?#&]gid=(\d+)/);
  return {
    spreadsheetId: match[1],
    gid: gidMatch ? Number(gidMatch[1]) : null
  };
}

function getSheetByGid_(ss, gid) {
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === gid) return sheets[i];
  }
  return null;
}

function parseBody_(e) {
  const raw = e && e.postData ? String(e.postData.contents || '') : '';
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch (err) { throw new Error('Request body must be valid JSON.'); }
}

function respond_(payload, callback) {
  const json = JSON.stringify(payload);
  if (callback) {
    const safeCallback = String(callback).replace(/[^a-zA-Z0-9_.$]/g, '');
    return ContentService
      .createTextOutput(safeCallback + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

function pickLabel_(text, mapping, fallback) {
  let bestLabel = fallback;
  let bestCount = 0;

  Object.keys(mapping).forEach(label => {
    const count = mapping[label].reduce((sum, term) => sum + (text.indexOf(term) >= 0 ? 1 : 0), 0);
    if (count > bestCount) {
      bestCount = count;
      bestLabel = label;
    }
  });

  return bestLabel;
}

function normalizeHeader_(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function valueAt_(row, index) {
  return index >= 0 && index < row.length ? String(row[index] || '').trim() : '';
}

function isBlankRow_(row) {
  return row.every(v => String(v || '').trim() === '');
}

function containsAny_(text, terms) {
  return terms.some(term => text.indexOf(term) >= 0);
}

function unique_(items) {
  const seen = {};
  return items.filter(item => {
    if (seen[item]) return false;
    seen[item] = true;
    return true;
  });
}
