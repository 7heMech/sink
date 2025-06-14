// app/utils/csv.ts

/**
 * Converts an array of objects into a CSV string.
 * @param data Array of objects to convert.
 * @returns A string representing the data in CSV format.
 */
export function convertToCSV(data: any[]): string {
  if (!data || data.length === 0) {
    return '';
  }

  const headers = Object.keys(data[0]);
  const csvRows: string[] = [];

  // Add header row
  csvRows.push(headers.join(','));

  // Add data rows
  for (const row of data) {
    const values = headers.map(header => {
      let value = row[header] === null || row[header] === undefined ? '' : String(row[header]);
      // Escape double quotes and handle values containing commas, newlines, or carriage returns
      if (/[",\n\r]/.test(value)) {
        value = '"' + value.replace(/"/g, '""') + '"';
      }
      return value;
    });
    csvRows.push(values.join(','));
  }
  return csvRows.join('\n');
}
