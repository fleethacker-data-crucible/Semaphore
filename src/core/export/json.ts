// The document as JSON, for other tools to read. Pictures are described, not included.

import type { ExportDocument } from './model.ts';

export const EXPORT_SCHEMA_VERSION = 1;

export function toJson(doc: ExportDocument): string {
  const { title, brief, takenAt, by, filters, accent } = doc;
  return JSON.stringify(
    {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      title,
      brief,
      takenAt,
      by,
      filters,
      accent,
      flags: doc.flags.map((flag) => ({
        ...flag,
        image: flag.image ? { width: flag.image.width, height: flag.image.height } : null,
      })),
    },
    null,
    2,
  );
}
