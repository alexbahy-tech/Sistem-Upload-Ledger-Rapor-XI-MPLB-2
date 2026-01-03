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
      case "checkStatus": result = checkFolderStatus(data.folderId); break;
      // LOGIKA BARU: Menerima parameter year dan semester
      case "getStudentFiles": result = getStudentFiles(data.folderId, data.year, data.semester); break; 
      case "add": result = addStudent(data); break;
      case "delete": result = deleteStudent(data.row); break;
      case "upload": result = uploadFileToDrive(data); break;
      default: result = { status: "error", message: "Action Unknown: " + action };
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
  const values = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
  return values.map((row, i) => ({
    row: i + 2,
    no: row[0], nis: row[1], nama: row[2], kelas: row[3], folderId: row[4],
    hasIdentitas: row[5] === "ADA", hasRapor: row[6] === "ADA"
  }));
}

// FUNGSI UTAMA: FILTER FILE BERDASARKAN TAHUN & SEMESTER
function getStudentFiles(folderId, yearStr, semesterStr) {
  if (!folderId) return { status: "error", message: "Folder ID missing" };
  
  try {
    const folder = DriveApp.getFolderById(folderId);
    const files = folder.getFiles();
    let fileList = [];
    
    // Konversi input UI ke format nama file
    // Input: "2024/2025" -> Jadi: "2024-2025" (karena nama file tidak boleh ada garis miring)
    // Input: "ganjil" -> Jadi: "ganjil"
    const searchYear = yearStr ? yearStr.replace(/\//g, '-') : ""; 
    const searchSem = semesterStr ? semesterStr.toLowerCase() : "";

    while (files.hasNext()) {
      let f = files.next();
      let name = f.getName();
      let lowerName = name.toLowerCase();
      
      let isMatch = false;
      let type = "Lainnya";

      // LOGIKA FILTER
      if (lowerName.includes("identitas")) {
        // Identitas muncul di semua tahun (bersifat global)
        isMatch = true; 
        type = "Identitas";
      } else if (lowerName.includes("rapor")) {
        // Rapor harus COCOK Tahun DAN Semesternya
        // Contoh nama file: "2024-2025_ganjil_Rapor_Budi.pdf"
        if (name.includes(searchYear) && lowerName.includes(searchSem)) {
          isMatch = true;
          type = "Rapor";
        }
      }

      if (isMatch) {
         fileList.push({
          name: name,
          url: f.getUrl(),
          type: type,
          date: f.getLastUpdated(),
          size: f.getSize()
        });
      }
    }
    
    // Urutkan file terbaru di atas
    fileList.sort((a, b) => b.date - a.date);
    
    return { status: "success", files: fileList };
  } catch (e) {
    return { status: "error", message: e.message };
  }
}

function checkFolderStatus(folderId) {
  if (folderId === "LEDGER") {
    const folder = DriveApp.getFolderById(CONFIG.LEDGER_FOLDER_ID);
    const files = folder.getFiles();
    return { status: "success", totalFiles: 0 }; // Sederhana saja untuk performa
  }
  return { status: "success" };
}

function addStudent(data) {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  const parentFolder = DriveApp.getFolderById(CONFIG.PARENT_FOLDER_ID);
  const folderName = `${data.nama} - ${data.nis}`;
  const newFolder = parentFolder.createFolder(folderName);
  newFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const newNo = Math.max(1, sheet.getLastRow());
  sheet.appendRow([newNo, data.nis, data.nama, "X AKL", newFolder.getId(), "", ""]); 
  return { status: "success" };
}

function deleteStudent(row) {
  const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(CONFIG.SHEET_NAME);
  sheet.deleteRow(parseInt(row));
  return { status: "success" };
}

function uploadFileToDrive(data) {
  try {
    if (!data.folderId) return { status: "error", message: "Folder ID Missing" };

    const targetId = (data.folderId === "LEDGER") ? CONFIG.LEDGER_FOLDER_ID : data.folderId;
    const folder = DriveApp.getFolderById(targetId);
    
    // Hapus file LAMA hanya jika Namanya SAMA PERSIS (Overwrite protection)
    const existing = folder.getFilesByName(data.fileName);
    while (existing.hasNext()) existing.next().setTrashed(true);
    
    const decoded = Utilities.base64Decode(data.fileData);
    const blob = Utilities.newBlob(decoded, data.mimeType, data.fileName);
    const file = folder.createFile(blob);
    
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    
    // Update Spreadsheet Status (Indikator Umum)
    if (data.folderId !== "LEDGER" && data.row) {
      const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(CONFIG.SHEET_NAME);
      const lowerName = data.fileName.toLowerCase();
      if(lowerName.includes("identitas")) sheet.getRange(data.row, 6).setValue("ADA");
      if(lowerName.includes("rapor")) sheet.getRange(data.row, 7).setValue("ADA");
    }
    
    return { status: "success", url: file.getUrl() };
  } catch (e) {
    return { status: "error", message: "Upload Failed: " + e.message };
  }
}
