// =======================================================
// 1. KONFIGURASI SISTEM
// =======================================================
const CONFIG = {
  SHEET_ID: "1S9Ed1Ad1bmBxEUacbb4BN0Ipe2Qw-b3X2xQ5YUObX4I", 
  SHEET_NAME: "Sheet1",
  PARENT_FOLDER_ID: "1lr5IvQGrflG5m10vbRagl-9vDlr7xRz7",
  LEDGER_FOLDER_ID: "1v8375dOSCgA3rJcFia-E_FLNkAhZm32F"
};

// =======================================================
// 2. API GATEWAY
// =======================================================

function doGet(e) { return handleRequest(e, true); }
function doPost(e) { return handleRequest(e, false); }

function handleRequest(e, isGet) {
  const lock = LockService.getScriptLock();
  lock.tryLock(30000); 

  try {
    let action = isGet ? e.parameter.action : JSON.parse(e.postData.contents).action;
    let data = isGet ? e.parameter : JSON.parse(e.postData.contents);
    let result;

    switch (action) {
      case "read": result = getAllStudents(); break;
      case "checkStatus": result = checkFolderStatus(data.folderId, data.row); break;
      case "add": result = addStudent(data); break;
      case "delete": result = deleteStudent(data.row); break;
      case "upload": result = uploadFileToDrive(data); break;
      default: result = { status: "error", message: "Action Unknown" };
    }
    return responseJSON(result);
  } catch (err) {
    return responseJSON({ status: "error", message: err.toString() });
  } finally {
    lock.releaseLock();
  }
}

// =======================================================
// 3. LOGIKA BISNIS
// =======================================================

function responseJSON(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function getAllStudents() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  
  if (lastRow < 2) return [];
  
  // Ambil data sampai Kolom G (7 Kolom)
  // 1:No | 2:NIS | 3:Nama | 4:Kelas | 5:FolderID | 6:StsIdentitas | 7:StsRapor
  const values = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
  
  return values.map((row, i) => ({
    row: i + 2,
    no: row[0],
    nis: row[1],
    nama: row[2],
    kelas: row[3],
    folderId: row[4],
    hasIdentitas: row[5] === "ADA", // Membaca status dari sheet
    hasRapor: row[6] === "ADA"      // Membaca status dari sheet
  }));
}

function checkFolderStatus(folderId, row) {
  if (!folderId) return { status: "error" };

  // Cek Ledger
  if (folderId === "LEDGER") {
    return checkLedgerFiles();
  }
  
  // Cek Siswa & Update Sheet
  try {
    const folder = DriveApp.getFolderById(folderId);
    const files = folder.getFiles();
    let fileList = [];
    let hasRapor = false;
    let hasIdentitas = false;

    while (files.hasNext()) {
      let f = files.next();
      let name = f.getName().toLowerCase();
      f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      
      if (name.includes("rapor")) hasRapor = true;
      if (name.includes("identitas")) hasIdentitas = true;

      fileList.push({ name: f.getName(), url: f.getUrl() });
    }

    // UPDATE SPREADSHEET STATUS
    if (row) {
      const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(CONFIG.SHEET_NAME);
      // Kolom 6 (F) untuk Identitas, 7 (G) untuk Rapor
      sheet.getRange(row, 6).setValue(hasIdentitas ? "ADA" : "");
      sheet.getRange(row, 7).setValue(hasRapor ? "ADA" : "");
    }

    return { status: "success", hasRapor, hasIdentitas, files: fileList };
  } catch (e) {
    return { status: "error", message: e.message };
  }
}

function checkLedgerFiles() {
  const folder = DriveApp.getFolderById(CONFIG.LEDGER_FOLDER_ID);
  const files = folder.getFiles();
  let fileList = [];
  while (files.hasNext()) {
    let f = files.next();
    f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    fileList.push({ name: f.getName(), url: f.getUrl(), date: f.getLastUpdated() });
  }
  return { status: "success", files: fileList, totalFiles: fileList.length };
}

function addStudent(data) {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  const parentFolder = DriveApp.getFolderById(CONFIG.PARENT_FOLDER_ID);
  
  const folderName = `${data.nama} - ${data.nis}`;
  const newFolder = parentFolder.createFolder(folderName);
  newFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const newNo = Math.max(1, sheet.getLastRow());
  sheet.appendRow([newNo, data.nis, data.nama, "X AKL", newFolder.getId(), "", ""]); // +2 kolom kosong
  
  return { status: "success" };
}

function deleteStudent(row) {
  const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(CONFIG.SHEET_NAME);
  sheet.deleteRow(parseInt(row));
  return { status: "success" };
}

function uploadFileToDrive(data) {
  try {
    const targetId = (data.folderId === "LEDGER") ? CONFIG.LEDGER_FOLDER_ID : data.folderId;
    const folder = DriveApp.getFolderById(targetId);
    
    // Hapus file lama (Duplikat)
    const existing = folder.getFilesByName(data.fileName);
    while (existing.hasNext()) existing.next().setTrashed(true);

    const decoded = Utilities.base64Decode(data.fileData);
    const blob = Utilities.newBlob(decoded, data.mimeType, data.fileName);
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    // AUTO UPDATE SHEET STATUS (Jika Upload Siswa)
    if (data.folderId !== "LEDGER" && data.row) {
      const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(CONFIG.SHEET_NAME);
      const lowerName = data.fileName.toLowerCase();
      if(lowerName.includes("identitas")) sheet.getRange(data.row, 6).setValue("ADA");
      if(lowerName.includes("rapor")) sheet.getRange(data.row, 7).setValue("ADA");
    }

    return { status: "success", url: file.getUrl() };
  } catch (e) {
    return { status: "error", message: e.message };
  }
}

