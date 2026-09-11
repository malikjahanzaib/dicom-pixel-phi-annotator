// Attributes the DICOM PS3.15 Annex E Basic Application Level Confidentiality Profile
// (Table E.1-1) treats as identifying. This is a READ-ONLY lens for finding what
// identifying text a file carries, so an operator knows which strings to look for burned
// into the pixels. It is not a de-identification tool: nothing here removes or rewrites a
// tag, and the profile describes metadata only — it says nothing about what is in the
// raster. Review this list against the current PS3.15 edition before relying on it as a
// completeness check; a tag being absent from it is not evidence that a file carries no PHI.
const TAGS = new Set([
  // Instance identity and creation
  '00080014', '00080018', '00080012', '00080013', '00080015', '00080201', '00081195', '00083010',
  // Study, series and content dates and times
  '00080020', '00080021', '00080022', '00080023', '00080024', '00080025', '0008002a',
  '00080030', '00080031', '00080032', '00080033', '00080034', '00080035',
  // Accession, institution and station
  '00080050', '00080051', '00080080', '00080081', '00080082', '00081010', '00081040', '00081041',
  // Physicians, operators and readers
  '00080090', '00080092', '00080094', '00080096', '00081048', '00081049', '00081050', '00081052',
  '00081060', '00081062', '00081070', '00081072',
  // Descriptions and free text that routinely carry identity
  '00081030', '0008103e', '00081080', '00081084', '00082111', '00084000', '00080058',
  // References that can relink a de-identified instance
  '00081110', '00081111', '00081120', '00081140', '00081155', '00081160', '00082112',
  // Patient identity
  '00100010', '00100020', '00100021', '00100022', '00100030', '00100032', '00100040',
  '00100050', '00100101', '00100102', '00101000', '00101001', '00101002', '00101005',
  '00101010', '00101020', '00101030', '00101040', '00101060', '00101080', '00101081',
  '00101090', '00101100', '00102000', '00102110', '00102150', '00102152', '00102154',
  '00102160', '00102180', '001021b0', '001021c0', '001021d0', '001021f0', '00102203', '00104000',
  // Clinical trial identifiers
  '00120010', '00120020', '00120021', '00120030', '00120031', '00120040', '00120042',
  '00120050', '00120051', '00120060', '00120071', '00120072', '00120081', '00120082',
  // Device and protocol identity
  '00181000', '00181002', '00181004', '00181005', '00181007', '00181008', '00181030',
  '00181400', '00184000', '0018700a', '0018700c', '0018a003', '00189424',
  // Image identity and comments
  '0020000d', '0020000e', '00200010', '00200052', '00200200', '00204000', '00209161', '00209164',
  '00284000', '00280303',
  // Overlay and curve groups, normalized from their repeating 50xx / 60xx forms
  '60003000', '60004000',
  // Study request and status
  '0032000a', '00321030', '00321032', '00321033', '00321060', '00321070', '00324000',
  // Visit and admission
  '00380010', '00380011', '0038001e', '00380020', '00380021', '00380040', '00380050',
  '00380060', '00380061', '00380062', '00380300', '00380400', '00380500', '00384000',
  // Scheduled and performed procedure steps
  '00400001', '00400002', '00400003', '00400004', '00400005', '00400006', '00400007',
  '0040000b', '00400010', '00400011', '00400012', '00400241', '00400242', '00400243',
  '00400244', '00400245', '00400250', '00400251', '00400253', '00400254', '00400275',
  '00400280', '00401001', '00401010', '00401400', '00402001', '00402008', '00402009',
  '00402010', '00402016', '00402017', '00402400', '00403001', '0040a027', '0040a075',
  '0040a078', '0040a07a', '0040a07c', '0040a123', '0040a124', '0040a730',
  // Results and interpretation
  '40080042', '40080102', '4008010a', '4008010b', '4008010c', '40080111', '40080114',
  '40080115', '40080118', '40080119', '4008011a', '40080202', '40080300', '40084000',
  // Content creator, icons and signatures
  '00700001', '00700084', '00700086', '00880140', '00880200', '04000100', '04000402', '04000403',
  // Frame of reference links
  '30060024', '300600c2',
]);
// Retired curve (50xx) and overlay (60xx) groups repeat, exactly as the tag dictionary does.
const normalize = hex => /^(50|60)[0-9a-f]{2}/.test(hex) ? hex.slice(0, 2) + '00' + hex.slice(4) : hex;
export const isPhiTag = tag => TAGS.has(normalize(tag.startsWith('x') ? tag.slice(1) : tag));
export const phiTagCount = TAGS.size;
