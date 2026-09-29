const fs = require('fs');
const TargetCore = require('./core.js');

// 1. Read the newly published master map
const data = JSON.parse(fs.readFileSync('euro-use-master-map.json', 'utf8'));

// 2. Compact the map using shared core logic
const out = TargetCore.compact(data);

// 3. Save it as the new compact file
fs.writeFileSync('euro-use-eligibility.json', JSON.stringify(out));
console.log(`Successfully compacted ${out.eligibleCount} dots into ${out.ranges.length} ranges.`);