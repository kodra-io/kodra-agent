import type { Bundle } from '@kodra-agent/templates';

/** Builds the bundle zip in the browser. Nothing is uploaded anywhere. */
export async function bundleZip(bundle: Bundle): Promise<Blob> {
  // Loaded on demand: most visits never download.
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const folder = zip.folder(bundle.root);
  if (!folder) throw new Error('could not create the bundle folder');
  for (const file of bundle.files) folder.file(file.path, file.content);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}
