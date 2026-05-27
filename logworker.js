import fs from 'fs';
import path from 'path';
import { workerData, parentPort } from 'worker_threads';

// ==========================================
// 💡 參數解析 (優先級：workerData > process.env > 預設值)
// ==========================================
const logDir = workerData?.logDir || process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const logName = workerData?.logName || process.env.LOG_NAME || 'server.log';

// 1. 必備：大小限制 (預設 10MB) 與 歷史編號上限 (預設保留 5 個)
const maxSizeBytes = workerData?.maxSizeBytes || parseInt(process.env.LOG_MAX_SIZE_BYTES, 10) || 10 * 1024 * 1024;
const maxFiles = workerData?.maxFiles || parseInt(process.env.LOG_MAX_FILES, 10) || 5;

// 2. 選用 (Options)：按天數滾動與清理 (預設為 false 不啟用，可傳入 true 啟用)
const enableDateRotation = workerData?.enableDateRotation === true || process.env.ENABLE_DATE_ROTATION === 'true';
const maxDays = workerData?.maxDays || parseInt(process.env.LOG_MAX_DAYS, 10) || 7; // 預設保留 7 天

// 解析基礎檔名與副檔名
const ext = path.extname(logName);
const baseName = path.basename(logName, ext);

// 確保 Log 目錄存在
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

// 全局狀態
let logStream = null;
let currentLogPath = '';
let currentTargetDateStr = '';

// 取得當前日期的 YYYY-MM-DD 字串
function getTodayStr() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

// 根據模式，計算出當前應該寫入的主 Log 檔案路徑
function getActiveLogPath() {
    if (enableDateRotation) {
        currentTargetDateStr = getTodayStr();
        // 啟用天數時的基礎檔名: easy-api-2026-05-27.log
        return path.join(logDir, `${baseName}-${currentTargetDateStr}${ext}`);
    } else {
        // 未啟用天數時的基礎檔名: easy-api.log
        return path.join(logDir, logName);
    }
}

// 初始化或換檔時建立 Stream
function initStream() {
    currentLogPath = getActiveLogPath();
    logStream = fs.createWriteStream(currentLogPath, { flags: 'a', encoding: 'utf8' });
}

// ==========================================
// 🔄 雙軌滾動與清理核心邏輯
// ==========================================

// 核心 1：大小滾動 (不論有沒有開日期，只要單一檔案滿了就觸發)
function checkAndRotateSize() {
    try {
        if (!fs.existsSync(currentLogPath)) return;
        const stats = fs.statSync(currentLogPath);
        if (stats.size < maxSizeBytes) return;

        // 🟢 關閉當前寫入流，釋放 Windows 檔案鎖 (File Lock)
        logStream.end();

        // 根據是否啟用日期，決定滾動的命名格式
        // 有開日期: easy-api-2026-05-27.1.log
        // 沒開日期: easy-api.1.log
        const filePrefix = enableDateRotation ? `${baseName}-${currentTargetDateStr}` : baseName;

        // 遞迴推擠舊的編號檔案
        for (let i = maxFiles - 1; i >= 1; i--) {
            const oldFile = path.join(logDir, `${filePrefix}.${i}${ext}`);
            const newFile = path.join(logDir, `${filePrefix}.${i + 1}${ext}`);
            if (fs.existsSync(oldFile)) {
                if (i === maxFiles - 1) fs.unlinkSync(oldFile);
                else fs.renameSync(oldFile, newFile);
            }
        }

        // 將滿了的主檔案更名為 .1 檔
        fs.renameSync(currentLogPath, path.join(logDir, `${filePrefix}.${1}${ext}`));

        // 重新開啟主檔案 Stream
        logStream = fs.createWriteStream(currentLogPath, { flags: 'a', encoding: 'utf8' });
    } catch (err) {
        process.stderr.write(`[Size Rotation Error] ${err.message}\n`);
    }
}

// 核心 2：跨天檢查與過期天數清理 (選用)
function checkAndRotateDate() {
    if (!enableDateRotation) return;

    try {
        const todayStr = getTodayStr();
        // 檢查是否跨天，若是則切換新檔案
        if (todayStr !== currentTargetDateStr) {
            logStream.end();
            initStream(); // 這會自動更新 currentTargetDateStr 與新路徑
        }

        // 清理超過 maxDays (天數) 的老舊歷史日誌
        const files = fs.readdirSync(logDir);
        
        // 找出所有屬於這個服務的日期日誌群組
        const dayGroups = new Set();
        files.forEach(f => {
            // 匹配範例: easy-api-2026-05-27
            if (f.startsWith(baseName + '-') && (f.endsWith(ext) || f.includes(`${ext}.`))) {
                // 擷取出其中的日期部分 '2026-05-27'
                const match = f.match(new RegExp(`${baseName}-(\\d{4}-\\d{2}-\\d{2})`));
                if (match && match[1]) dayGroups.add(match[1]);
            }
        });

        // 將蒐集到的歷史日期排序 (由新到舊)
        const sortedDays = Array.from(dayGroups).sort((a, b) => new Date(b) - new Date(a));

        // 如果存在的總天數大於設定的 maxDays，找出過期的日期並把該日期的所有大小分割檔一併刪除
        if (sortedDays.length > maxDays) {
            const expiredDays = sortedDays.slice(maxDays);
            
            files.forEach(f => {
                expiredDays.forEach(expiredDay => {
                    if (f.startsWith(`${baseName}-${expiredDay}`)) {
                        try { fs.unlinkSync(path.join(logDir, f)); } catch (e) {}
                    }
                });
            });
        }
    } catch (err) {
        process.stderr.write(`[Date Rotation Error] ${err.message}\n`);
    }
}

// 寫入進入點
function handleWrite(message) {
    checkAndRotateDate(); // 1. 先驗證是否跨天 (選用)
    checkAndRotateSize(); // 2. 再驗證大小是否爆表 (必備)
    logStream.write(message);
}

// ==========================================
// 啟動監聽
// ==========================================
initStream();

if (parentPort) {
    parentPort.on('message', handleWrite);
} else {
    process.stdin.on('data', (data) => handleWrite(data.toString()));
}

process.on('exit', () => {
    if (logStream) logStream.end();
});