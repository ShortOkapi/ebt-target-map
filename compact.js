const fs = require('node:fs');
const path = require('node:path');
const TargetCore = require('./core.js');

// Resolve both map files relative to this script, including when run elsewhere.
const masterPath = path.join(__dirname, 'euro-use-master-map.json');
const compactPath = path.join(__dirname, 'euro-use-eligibility.json');

// Use the same validation and compaction as the browser's eligibility export.
const data = JSON.parse(fs.readFileSync(masterPath, 'utf8'));
const out = TargetCore.compact(data);

// Validation completes before the existing output file is opened for writing.
fs.writeFileSync(compactPath, JSON.stringify(out));
console.log(`Successfully compacted ${out.eligibleCount} dots into ${out.ranges.length} ranges.`);