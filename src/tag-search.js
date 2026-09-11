export const TAG_FILTERS=['all','phi','standard','private','sequences'];
const inFilter=(row,filter)=>filter==='all'||filter==='phi'&&row.phi||filter==='standard'&&!row.private||filter==='private'&&row.private||filter==='sequences'&&row.sequence;
export function filterTags(rows,query='',filter='all') {
  const q=query.trim().toLowerCase(),hex=q.replace(/^0x|^x/,'').replace(/[(),\s]/g,'');
  const hexQuery=hex.length>=4&&/^[0-9a-f]+$/.test(hex);
  return rows.filter(row=>inFilter(row,filter)&&(!q||`${row.tag} ${row.name} ${row.keyword} ${row.vr} ${row.value} ${row.path}`.toLowerCase().includes(q)||hexQuery&&row.hex.includes(hex)));
}
export function tagCounts(rows) {
  const counts=Object.fromEntries(TAG_FILTERS.map(filter=>[filter,0]));
  for(const row of rows)for(const filter of TAG_FILTERS)if(inFilter(row,filter))counts[filter]++;
  return counts;
}
