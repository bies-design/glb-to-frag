import http from 'http';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';

import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';

// 🟢 修正 ESM 環境在 Windows 下無法直接使用 __dirname 的問題
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 9000; // 讓 Caddy 反向代理或外界直接呼叫的 Port

// ==========================================
// 🚀 1. 宣告並啟用 Log Worker 執行緒
// ==========================================
const workerPath = path.join(__dirname, 'logWorker.js');
const logWorker = new Worker(workerPath, {
    workerData: {
        logDir: path.join(__dirname, '..', 'logs'), // 儲存資料夾
        logName: 'glb-to-frag.log',             // 基礎 Log 檔名
        maxSizeBytes: 10 * 1024 * 1024,      // 必備：單檔上限 10MB
        maxFiles: 7,                         // 必備：大小滾動最多保留 5 個檔案
        enableDateRotation: true,            // 選用 (Option)：啟用按天數滾動與清理
        maxDays: 7                           // 選用 (Option)：保留最近 7 天的日誌
    }
});

// ==========================================
// 🔄 2. 安全的日誌控管器（替代高風險的全域劫持）
// ==========================================
const logger = {
    info(msg) {
        process.stdout.write(`[INFO] ${msg}\n`); // 正常輸出到終端機
        logWorker.postMessage(`[INFO] ${msg}\n`); // 傳送給 Worker
    },
    error(msg) {
        process.stderr.write(`[ERROR] ${msg}\n`);
        logWorker.postMessage(`[ERROR] ${msg}\n`);
    }
};

// ==========================================
// 🌐 3. API 伺服器核心管線
// ==========================================
const server = http.createServer((req, res) => {
    // 統一設定回應格式為 JSON 與基礎 CORS 防護
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // 處理瀏覽器或 API 工具的 Preflight 請求
    if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        return res.end();
    }

    // Health Check Endpoint，供監控系統或 Caddy 健康檢查使用
    if (req.method === 'GET' && req.url === '/api/health') {
        res.statusCode = 200;
        return res.end(JSON.stringify({ status: 'ok' }));
    }

    // 唯有 POST /api/convert 才能進入轉檔管線
    if (req.method === 'POST' && req.url === '/api/convert') {
        let body = '';
        let cleanBody = '';

        // 接收 A 電腦傳過來的 JSON 數據
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            let payload;

            // 1. 專職負責 JSON 解析的 try-catch，不與後續邏輯混在一起
            try {
                const cleanBody = body.trim().replace(/^\uFEFF/, '');
                payload = JSON.parse(cleanBody);
            } catch (err) {
                logger.error(`[❌ 真正的 JSON 解析失敗]: ${err.message}`);
                logger.info("=== 異常 Byte 結構 ===");
                logger.info(Array.from(body).map(c => `${c.charCodeAt(0).toString(16)}(${c})`).join(' '));

                payload = ''; // 確保 payload 是一個空字串，避免後續使用時出現 undefined 的錯誤
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                return res.end(JSON.stringify({
                    status: "error",
                    message: `傳入的資料確實不是標準 JSON 格式: ${err.message}`
                }));
            }

            logger.info(`\n[📡 收到請求] 完成解析`);
            // 2. 解析成功後，提取參數並驗證
            const { input_path, output_dir } = payload;
            // 基礎參數防呆驗證
            if (!input_path || !output_dir) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                return res.end(JSON.stringify({ 
                    status: "error", 
                    message: "缺漏必要參數：input_path 或 output_dir" 
                }));
            }

            logger.info(`\n[${new Date().toISOString()}] 📥 收到 Frag 轉檔請求:`);
            logger.info(`   - 輸入 GLB: ${input_path}`);
            logger.info(`   - 輸出目錄: ${output_dir}`);

            // 🟢 核心原子操作：精確套用 npm run pipeline -- 參數帶入規範
            // 使用雙引號包裹路徑，防止 Windows 路徑中的空格造成 CLI 解析錯誤
            const cmd = `npm run pipeline -- "${input_path}" "${output_dir}"`;
            logger.info(`[🚀 Pipeline 執行中] 指令: ${cmd}`);

            //3. 執行命令，並設定 cwd 確保在專案根目錄下執行
            exec(cmd, { cwd: __dirname }, (error, stdout, stderr) => {
                if (error) {
                    logger.error(`[❌ Pipeline 執行失敗]: ${error.message}`);
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                    return res.end(JSON.stringify({ 
                        status: "failed", 
                        message: "Pipeline 腳本執行失敗",
                        error: error.message,
                        stderr: stderr,
                        stdout: stdout // 有時編譯出錯的詳細訊息會留在 stdout 中
                    }));
                }

                // 轉檔成功，將腳本運行的終端機輸出 (stdout) 完整回傳給 A 電腦
                logger.info(`[✅ Pipeline 執行成功]`);

                // 額外把材質包壓縮成 zip
                try {
                    const fileNameWithoutExt = path.basename(input_path, path.extname(input_path));
                    const absoluteMaterialsPath = path.join(output_dir, fileNameWithoutExt);
                    // 🟢 轉檔成功後，檢查材質資料夾是否存在，存在才進行壓縮
                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                    if (fs.existsSync(absoluteMaterialsPath)) {
                        // 在 Windows 環境下使用 PowerShell 的 Compress-Archive 指令來壓縮材質包，並確保路徑正確處理
                        // exec(`powershell -Command "Compress-Archive -Path '${absoluteMaterialsPath}' -DestinationPath '${absoluteMaterialsPath}.zip'"`, { cwd: __dirname }, (error, stdout, stderr) => {
                        const tarCmd = `tar -cjf "${fileNameWithoutExt}.bzip2" -C "${output_dir}" ./"${fileNameWithoutExt}"`;
                                            
                        exec(tarCmd, { cwd: __dirname }, (zipError, zipStdout, zipStderr) => {
                            if (zipError) {
                                logger.error(`[❌ 壓縮材質包失敗]: ${zipError.message}`);
                                res.statusCode = 200;
                                return res.end(JSON.stringify({ 
                                    status: "completed", 
                                    message: `GLB 轉換成功，但材質包壓縮失敗`, 
                                    error: zipError.message,
                                    stdout: zipStdout,
                                    stderr: zipStderr,
                                    fragresult: `${absoluteMaterialsPath}.frag`
                                }));
                            }
                            logger.info(`[✅ 壓縮材質包成功] 儲存至: ${path.join(output_dir, fileNameWithoutExt + '.bzip2')}`);
                            res.statusCode = 200;
                            return res.end(JSON.stringify({ 
                                status: "completed", 
                                message: "GLB 轉換成功，材質包壓縮成功", 
                                stdout: zipStdout,
                                ziptype: "bzip2",
                                fragresult: `${absoluteMaterialsPath}.frag`
                            }));
                        });
                    } else {
                        // 如果該模型本來就是純幾何、沒有任何材質貼圖
                        logger.info(`[提示] 此模型未產出材質資料夾，跳過壓縮步驟。`);
                        res.statusCode = 200;
                        return res.end(JSON.stringify({ 
                            status: "completed", 
                            message: "GLB 轉換成功，無材質包不必壓縮", 
                            stdout: stdout,
                            error: "No materials folder generated, skipping compression step.", // 這裡的 error 欄位只是為了讓 A 電腦能夠在收到回應後知道為什麼沒有壓縮包，而不是實際的錯誤 
                            fragresult: `${absoluteMaterialsPath}.frag`
                        }));
                    }
                } catch (innerErr) {
                    // 預防 path 或 fs 模組未正確引入時崩潰
                    logger.error(`[❌ 執行後續路徑/壓縮邏輯時發生代碼錯誤]: ${innerErr.message}`);
                    res.statusCode = 500;
                    return res.end(JSON.stringify({ status: "error", message: `伺服器內部代碼錯誤: ${innerErr.message}` }));
                }
            });
        });
    } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ 
            status: "error", 
            message: "找不到此路由，請確認使用 POST /api/convert" 
        }));
    }
});

// ==========================================
// 🚀 4. 監聽錯誤事件並啟動伺服器
// ==========================================

// 🟢 監聽啟動失敗或運行中的異常錯誤
server.on('error', (err) => {
    logger.error(`\n[❌ Atomic API Server 啟動或運行失敗]:`);
    logger.error(`   - 錯誤代碼 (Code): ${err.code}`);
    logger.error(`   - 錯誤訊息 (Message): ${err.message}`);
    logger.error(`================================================================`);
    
    // 根據 Windows 服務常規，啟動失敗時通常會調用 process.exit(1) 
    // 這樣 qckwinsvr 才能偵測到服務異常中止，並觸發自動重啟機制
    process.exit(1);
});

// 啟動監聽，並在成功啟動後輸出服務資訊
server.listen(PORT, () => {
    logger.info(`================================================================`);
    logger.info(`🟢 [Atomic API Server] glb-to-frag 內嵌微服務已成功啟動`);
    logger.info(`   - 本地監聽埠: http://localhost:${PORT}`);
    logger.info(`   - 轉檔路由點: http://localhost:${PORT}/api/convert`);
    logger.info(`================================================================`);
});