// The device combination, read from the file rather than assigned. A combo ID is a label
// somebody chose and can be changed or mistyped; these four attributes are what actually
// determine the burned-in layout, and they never change for a given file. Surfacing them
// beside the ID is what makes a wrong ID visible instead of silently mis-grouping work.
export const DEVICE_TAGS = {
  manufacturer: 'x00080070',   // (0008,0070) Manufacturer
  model:        'x00081090',   // (0008,1090) ManufacturerModelName
  sopClass:     'x00080016',   // (0008,0016) SOPClassUID
  software:     'x00181020',   // (0018,1020) SoftwareVersions
};
export const DEVICE_FIELDS = Object.keys(DEVICE_TAGS);

// Raw UIDs are unreadable in a sidebar. Anything not listed falls back to the UID itself,
// so an unrecognised class is unlabelled rather than mislabelled.
const SOP_CLASSES = {
  '1.2.840.10008.5.1.4.1.1.6.1': 'Ultrasound Image',
  '1.2.840.10008.5.1.4.1.1.3.1': 'Ultrasound Multi-frame Image',
  '1.2.840.10008.5.1.4.1.1.7': 'Secondary Capture Image',
  '1.2.840.10008.5.1.4.1.1.7.1': 'Multi-frame Single Bit Secondary Capture',
  '1.2.840.10008.5.1.4.1.1.7.2': 'Multi-frame Grayscale Byte Secondary Capture',
  '1.2.840.10008.5.1.4.1.1.7.3': 'Multi-frame Grayscale Word Secondary Capture',
  '1.2.840.10008.5.1.4.1.1.7.4': 'Multi-frame True Color Secondary Capture',
  '1.2.840.10008.5.1.4.1.1.1': 'Computed Radiography Image',
  '1.2.840.10008.5.1.4.1.1.1.2': 'Digital Mammography X-Ray Image — For Presentation',
  '1.2.840.10008.5.1.4.1.1.2': 'CT Image',
  '1.2.840.10008.5.1.4.1.1.4': 'MR Image',
};
export const sopClassName = uid => SOP_CLASSES[String(uid || '').trim()] || String(uid || '').trim() || '';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
export const hasDevice = metadata => DEVICE_FIELDS.some(field => clean(metadata?.[field]));

// Null when the file carries none of the four, so "unknown" never compares equal to
// "unknown" and makes two files look like the same machine.
export function deviceSignature(metadata) {
  if (!hasDevice(metadata)) return null;
  return DEVICE_FIELDS.map(field => clean(metadata?.[field])).join('|');
}

// Vendors often prefix the software version with the model — "LOGIQ9:R9.0.0". Dropping
// that prefix for display costs nothing and buys the version room to be read in a narrow
// rail, which is usually the attribute that distinguishes one combination from another.
// The signature always uses the raw value.
export function shortSoftware(metadata) {
  const software = clean(metadata?.software), model = clean(metadata?.model);
  if (!model || !software) return software;
  const prefix = new RegExp(`^${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:\\-]\\s*`, 'i');
  return software.replace(prefix, '') || software;
}

// Manufacturer, model and software identify the machine at a glance; the SOP class is
// carried in the signature and shown where there is room for it.
export function deviceLabel(metadata) {
  const parts = [clean(metadata?.manufacturer), clean(metadata?.model), shortSoftware(metadata)].filter(Boolean);
  return parts.join(' · ');
}

export function deviceDetail(metadata) {
  const parts = [deviceLabel(metadata), sopClassName(metadata?.sopClass)].filter(Boolean);
  return parts.join(' · ');
}

// More than one signature inside a combo means the ID groups files from different
// machines — either the ID is wrong, or the layout assumption behind it is.
export function deviceSignatures(images) {
  const seen = new Set();
  for (const image of images) {
    const signature = deviceSignature(image?.metadata);
    if (signature) seen.add(signature);
  }
  return [...seen];
}
