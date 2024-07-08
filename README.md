# Xlsx-Zip
[![NPM](https://nodei.co/npm/xlsx-zip.png)](https://nodei.co/npm/xlsx-zip)

Xlsx-Zip is a library that adapts for Office Xlsx Zip format. You can use it to compress xlsx's metadata, but can't extract.

this library is inspired by [node-compress-commons](https://github.com/archiverjs/node-compress-commons) and [node-zip](https://github.com/kyriosli/node-zip).

## Feature
* Zip format compatible with Office Xlsx
* Support zip64
* Support both stream and buffer output

## Why this project
Microsoft Office Xlsx Zip doesn't adapt standard Zip([PK-ZIP](https://pkwaredownloads.blob.core.windows.net/pkware-general/Documentation/APPNOTE-6.3.0.TXT)) format completely, which doesn't support ZIP64 Central Directory. So most Zip library can't generate a standard Office Xlsx file. The library is created to generate it perfectly.

### Reference
* [xlsx zip64 compatibility](https://issues.apache.org/jira/browse/COMPRESS-474)
* [Excel and ZIP64](https://rzymek.github.io/post/excel-zip64/)

## Install
```sh
npm i xlsx-zip
```

## Usage

### Buffer
```javascript
const { XlsxZip } = require('xlsx-zip');
const fs = require('fs');

async function main() {
  // don't set `stream` parameter
  const xlsxZip = new XlsxZip();

  const dirPath = 'directory/path';
  // add by directory
  await xlsxZip.addDirectory(null, dirPath);
  // add by Buffer
  await xlsxZip.add('entry/path1', Buffer.from('entry'));
  // add by file path
  await xlsxZip.add('entry/path2', 'file/path');

  const buf = await xlsxZip.finish();

  fs.writeFileSync('./output.xlsx', buf);
}
```

### Stream
```javascript
const { XlsxZip } = require('xlsx-zip');
const fs = require('fs');

async function main() {
  const stream = fs.createWriteStream('./output.xlsx');
  const xlsxZip = new XlsxZip({ stream });

  stream.on('close', () => {
    console.log('done');
  });

  const dirPath = 'directory/path';
  // add by directory
  await xlsxZip.addDirectory(null, dirPath);
  // add by Buffer
  await xlsxZip.add('entry/path1', Buffer.from('entry'));
  // add by file path
  await xlsxZip.add('entry/path2', 'file/path');

  await xlsxZip.finish();
}
```