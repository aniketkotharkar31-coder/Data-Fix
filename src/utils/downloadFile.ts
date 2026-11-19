/**
 * Downloads a binary or text file from a DataFix backend export endpoint,
 * surfacing structured JSON errors cleanly instead of failing silently.
 */
export async function downloadFileFromApi(
  url: string,
  fallbackFilename: string
): Promise<{ filename: string; sizeBytes: number }> {
  const response = await fetch(url);
  if (!response.ok) {
    let errorMessage = `Export request failed with status ${response.status}.`;
    try {
      const payload = (await response.json()) as { error?: unknown };
      if (typeof payload?.error === 'string' && payload.error.trim().length > 0) {
        errorMessage = payload.error;
      }
    } catch {
      // Response was not JSON; retain HTTP status message
    }
    throw new Error(errorMessage);
  }

  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
  const filename = filenameMatch?.[1]?.trim() || fallbackFilename;

  const objectUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    // Allow browser download manager to read the object URL before revoking
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }

  return { filename, sizeBytes: blob.size };
}
