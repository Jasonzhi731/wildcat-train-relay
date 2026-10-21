/**
 * 模擬 Google Apps Script 環境（只用於本機模擬模式與自動測試，正式網站不會載入）。
 * 讓 apps-script/Code.gs 不用上傳到 Google 也能在瀏覽器裡執行。
 *
 * 模擬了 Google Sheet 的兩個常見陷阱，讓測試能抓到：
 *  - 沒有設成「純文字」格式的儲存格，寫入 "0912345678" 會變成數字 912345678（開頭的 0 不見）
 *  - 寫入 "TRUE"／"FALSE" 會變成布林值
 */
(function (global) {
  'use strict';

  // ---------- SHA-256／HMAC（同步版本，因為 Apps Script 的 Utilities 是同步的） ----------
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function utf8(str) {
    return Array.from(new TextEncoder().encode(String(str)));
  }

  function sha256(bytes) {
    const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const msg = bytes.slice();
    const bitLen = bytes.length * 8;
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    for (let i = 7; i >= 0; i--) msg.push(Math.floor(bitLen / Math.pow(2, i * 8)) & 0xff);
    const w = new Array(64);
    for (let off = 0; off < msg.length; off += 64) {
      for (let i = 0; i < 16; i++) {
        w[i] = (msg[off + i * 4] << 24) | (msg[off + i * 4 + 1] << 16) | (msg[off + i * 4 + 2] << 8) | msg[off + i * 4 + 3];
      }
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    const out = [];
    h.forEach(function (x) { out.push((x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff); });
    return out;
  }

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  function hmacSha256(keyBytes, msgBytes) {
    let key = keyBytes.length > 64 ? sha256(keyBytes) : keyBytes.slice();
    while (key.length < 64) key.push(0);
    const ipad = key.map(function (b) { return b ^ 0x36; });
    const opad = key.map(function (b) { return b ^ 0x5c; });
    return sha256(opad.concat(sha256(ipad.concat(msgBytes))));
  }

  /** Apps Script 的 byte[] 是 -128～127 的有號數字。 */
  function signed(bytes) {
    return bytes.map(function (b) { return b > 127 ? b - 256 : b; });
  }

  // ---------- 試算表 ----------
  function isEmpty(v) {
    return v === '' || v === null || v === undefined;
  }

  /** 模擬 Google Sheet 的自動轉換（非純文字格式時）。 */
  function convert(v, isText) {
    if (isText || typeof v !== 'string') return v;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (/^true$/i.test(v)) return true;
    if (/^false$/i.test(v)) return false;
    return v;
  }

  function MockSheet(name) {
    this.name = name;
    this.data = [];       // data[r][c]（從 0 開始）
    this.textRects = [];  // 設為純文字格式的範圍 [r1, c1, r2, c2]（從 1 開始，含頭尾）
    this.maxRows = 1000;
    this.maxCols = 26;
    this.frozen = 0;
  }

  MockSheet.prototype = {
    getName: function () { return this.name; },
    getMaxRows: function () { return this.maxRows; },
    getMaxColumns: function () { return this.maxCols; },
    getLastRow: function () {
      for (let r = this.data.length - 1; r >= 0; r--) {
        const row = this.data[r];
        if (row && row.some(function (v) { return !isEmpty(v); })) return r + 1;
      }
      return 0;
    },
    getLastColumn: function () {
      let max = 0;
      this.data.forEach(function (row) {
        if (!row) return;
        for (let c = row.length - 1; c >= 0; c--) {
          if (!isEmpty(row[c])) { max = Math.max(max, c + 1); break; }
        }
      });
      return max;
    },
    getRange: function (row, col, numRows, numCols) {
      numRows = numRows || 1;
      numCols = numCols || 1;
      if (row < 1 || col < 1 || numRows < 1 || numCols < 1) throw new Error('範圍不正確');
      if (row + numRows - 1 > this.maxRows || col + numCols - 1 > this.maxCols) {
        throw new Error('範圍超出工作表格線（' + this.name + '）');
      }
      return new MockRange(this, row, col, numRows, numCols);
    },
    getDataRange: function () {
      return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1));
    },
    isText: function (r, c) {
      return this.textRects.some(function (x) { return r >= x[0] && r <= x[2] && c >= x[1] && c <= x[3]; });
    },
    getCell: function (r, c) {
      const row = this.data[r - 1];
      return row && !isEmpty(row[c - 1]) ? row[c - 1] : '';
    },
    setCell: function (r, c, v) {
      while (this.data.length < r) this.data.push([]);
      const row = this.data[r - 1];
      while (row.length < c) row.push('');
      row[c - 1] = convert(v, this.isText(r, c));
    },
    appendRow: function (values) {
      const r = this.getLastRow() + 1;
      if (r > this.maxRows) this.maxRows = r;
      const self = this;
      values.forEach(function (v, i) { self.setCell(r, i + 1, v); });
      return this;
    },
    deleteRow: function (r) {
      if (this.maxRows - this.frozen <= 1) throw new Error('不能刪除所有未凍結的列');
      this.data.splice(r - 1, 1);
      this.maxRows -= 1;
      this.textRects = this.textRects.map(function (x) {
        if (x[0] > r) return [x[0] - 1, x[1], x[2] - 1, x[3]];
        if (x[2] >= r) return [x[0], x[1], x[2] - 1, x[3]];
        return x;
      }).filter(function (x) { return x[2] >= x[0]; });
      return this;
    },
    insertRowsAfter: function (after, n) {
      this.maxRows += n;
      return this;
    },
    insertColumnsAfter: function (after, n) {
      this.maxCols += n;
      return this;
    },
    setFrozenRows: function (n) { this.frozen = n; return this; },
    setColumnWidth: function () { return this; },
    autoResizeColumns: function () { return this; },
  };

  function MockRange(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }

  MockRange.prototype = {
    getValues: function () {
      const out = [];
      for (let r = 0; r < this.numRows; r++) {
        const line = [];
        for (let c = 0; c < this.numCols; c++) line.push(this.sheet.getCell(this.row + r, this.col + c));
        out.push(line);
      }
      return out;
    },
    getValue: function () { return this.getValues()[0][0]; },
    setValues: function (values) {
      if (!Array.isArray(values) || values.length !== this.numRows) throw new Error('setValues 列數不符');
      for (let r = 0; r < this.numRows; r++) {
        if (!Array.isArray(values[r]) || values[r].length !== this.numCols) throw new Error('setValues 欄數不符');
        for (let c = 0; c < this.numCols; c++) this.sheet.setCell(this.row + r, this.col + c, values[r][c]);
      }
      return this;
    },
    setValue: function (v) {
      for (let r = 0; r < this.numRows; r++) {
        for (let c = 0; c < this.numCols; c++) this.sheet.setCell(this.row + r, this.col + c, v);
      }
      return this;
    },
    setNumberFormat: function (fmt) {
      if (fmt === '@') this.sheet.textRects.push([this.row, this.col, this.row + this.numRows - 1, this.col + this.numCols - 1]);
      return this;
    },
    insertCheckboxes: function () {
      // 真實的 insertCheckboxes 會把值設為 false
      return this.setValue(false);
    },
    setFontWeight: function () { return this; },
    setBackground: function () { return this; },
    setWrap: function () { return this; },
  };

  function MockSpreadsheet() {
    this.sheets = [];
  }

  MockSpreadsheet.prototype = {
    getSheetByName: function (name) {
      return this.sheets.find(function (s) { return s.name === name; }) || null;
    },
    insertSheet: function (name) {
      if (this.getSheetByName(name)) throw new Error('工作表已存在：' + name);
      const s = new MockSheet(name);
      this.sheets.push(s);
      return s;
    },
    getSheets: function () { return this.sheets.slice(); },
  };

  // ---------- 全域狀態 ----------
  let spreadsheet = new MockSpreadsheet();
  let props = {};

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  global.SpreadsheetApp = {
    getActiveSpreadsheet: function () { return spreadsheet; },
    flush: function () {},
  };

  global.LockService = {
    getScriptLock: function () {
      return { waitLock: function () {}, tryLock: function () { return true; }, releaseLock: function () {}, hasLock: function () { return true; } };
    },
  };

  global.PropertiesService = {
    getScriptProperties: function () {
      return {
        getProperty: function (k) { return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null; },
        setProperty: function (k, v) { props[k] = String(v); return this; },
        deleteProperty: function (k) { delete props[k]; return this; },
        getProperties: function () { return Object.assign({}, props); },
      };
    },
  };

  global.Utilities = {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    computeDigest: function (alg, value) {
      if (alg !== 'SHA_256') throw new Error('模擬環境只支援 SHA_256');
      return signed(sha256(typeof value === 'string' ? utf8(value) : value.map(function (b) { return b & 0xff; })));
    },
    computeHmacSha256Signature: function (value, key) {
      return signed(hmacSha256(utf8(key), utf8(value)));
    },
    formatDate: function (date, tz, pattern) {
      if (tz !== 'Asia/Taipei') throw new Error('模擬環境只支援 Asia/Taipei');
      const d = new Date(date.getTime() + 8 * 3600000);
      return pattern
        .replace('yyyy', d.getUTCFullYear())
        .replace('MM', pad(d.getUTCMonth() + 1))
        .replace('dd', pad(d.getUTCDate()))
        .replace('HH', pad(d.getUTCHours()))
        .replace('mm', pad(d.getUTCMinutes()))
        .replace('ss', pad(d.getUTCSeconds()));
    },
    getUuid: function () {
      if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (ch) {
        const r = Math.random() * 16 | 0;
        return (ch === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    },
  };

  global.ContentService = {
    MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
    createTextOutput: function (s) {
      return {
        content: s,
        setMimeType: function () { return this; },
        getContent: function () { return this.content; },
      };
    },
  };

  global.MockGas = {
    reset: function () {
      spreadsheet = new MockSpreadsheet();
      props = {};
    },
    exportState: function () {
      return {
        props: Object.assign({}, props),
        sheets: spreadsheet.sheets.map(function (s) {
          return { name: s.name, data: s.data, textRects: s.textRects, maxRows: s.maxRows, maxCols: s.maxCols, frozen: s.frozen };
        }),
      };
    },
    importState: function (state) {
      spreadsheet = new MockSpreadsheet();
      props = Object.assign({}, state.props || {});
      (state.sheets || []).forEach(function (x) {
        const s = spreadsheet.insertSheet(x.name);
        s.data = x.data || [];
        s.textRects = x.textRects || [];
        s.maxRows = x.maxRows || 1000;
        s.maxCols = x.maxCols || 26;
        s.frozen = x.frozen || 0;
      });
    },
    sha256Hex: function (str) {
      return sha256(utf8(str)).map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    },
    hmacHex: function (key, msg) {
      return hmacSha256(utf8(key), utf8(msg)).map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    },
  };
})(window);
