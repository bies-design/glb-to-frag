import http from 'http';
import path from 'path';
import fs from 'fs';
import exec from 'child_process';

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
// 🔄 2. 劫持並拋接 stdout / stderr 到 Worker
// ==========================================
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

process.stdout.write = (chunk, encoding, callback) => {
    // 拋接給 logWorker.js 執行緒處理檔案 I/O
    logWorker.postMessage(`[INFO] ${chunk.toString()}`);
    // 同時保持向 Windows 終端機標準輸出，供 qckwinsvr 擷取
    return originalStdoutWrite(chunk, encoding, callback);
};

process.stderr.write = (chunk, encoding, callback) => {
    logWorker.postMessage(`[ERROR] ${chunk.toString()}`);
    return originalStderrWrite(chunk, encoding, callback);
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

        // 接收 A 電腦傳過來的 JSON 數據
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const payload = JSON.parse(body);
                const { input_path, output_dir } = payload;

                // 基礎參數防呆驗證
                if (!input_path || !output_dir) {
                    res.statusCode = 400;
                    return res.end(JSON.stringify({ 
                        status: "error", 
                        message: "缺漏必要參數：input_path 或 output_dir" 
                    }));
                }

                console.log(`\n[${new Date().toISOString()}] 📥 收到 Frag 轉檔請求:`);
                console.log(`   - 輸入 GLB: ${input_path}`);
                console.log(`   - 輸出目錄: ${output_dir}`);

                // 🟢 核心原子操作：精確套用 npm run pipeline -- 參數帶入規範
                // 使用雙引號包裹路徑，防止 Windows 路徑中的空格造成 CLI 解析錯誤
                const cmd = `npm run pipeline -- "${input_path}" "${output_dir}"`;

                console.log(`[🚀 Pipeline 執行中] 指令: ${cmd}`);

                // 執行命令，並設定 cwd 確保在專案根目錄下執行
                exec(cmd, { cwd: __dirname }, (error, stdout, stderr) => {
                    if (error) {
                        console.error(`[❌ Pipeline 執行失敗]: ${error.message}`);
                        res.statusCode = 500;
                        return res.end(JSON.stringify({ 
                            status: "failed", 
                            error: error.message,
                            stderr: stderr,
                            stdout: stdout // 有時編譯出錯的詳細訊息會留在 stdout 中
                        }));
                    }

                    // 轉檔成功，將腳本運行的終端機輸出 (stdout) 完整回傳給 A 電腦
                    console.log(`[✅ Pipeline 執行成功]`);

                    // 額外把材質包壓縮成 zip
                    const fileNameWithoutExt = path.basename(input_path, path.extname(input_path));
                    const absoluteMaterialsPath = path.join(output_dir, fileNameWithoutExt);
                    // 🟢 轉檔成功後，檢查材質資料夾是否存在，存在才進行壓縮
                    if (fs.existsSync(absoluteMaterialsPath)) {
                        // 在 Windows 環境下使用 PowerShell 的 Compress-Archive 指令來壓縮材質包，並確保路徑正確處理
                        // exec(`powershell -Command "Compress-Archive -Path '${absoluteMaterialsPath}' -DestinationPath '${absoluteMaterialsPath}.zip'"`, { cwd: __dirname }, (error, stdout, stderr) => {
                        exec(`tar -cjf "${fileNameWithoutExt}.bzip2" -C "${output_dir}" ./"${fileNameWithoutExt}"`, { cwd: __dirname }, (error, stdout, stderr) => {
                            if (error) {
                                console.error(`[❌ 壓縮材質包失敗]: ${error.message}`);
                                res.statusCode = 200;
                                res.end(JSON.stringify({ 
                                    status: "completed", 
                                    message: `GLB 轉換成功，但材質包壓縮失敗`, 
                                    error: error.message,
                                    stdout: stdout,
                                    stderr: stderr,
                                    fragresult: `${absoluteMaterialsPath}.frag`
                                }));
                            } else {
                                console.log(`[✅ 壓縮材質包成功] 儲存至: ${path.join(output_dir, fileNameWithoutExt + '.bzip2')}`);
                                res.statusCode = 200;
                                res.end(JSON.stringify({ 
                                    status: "completed", 
                                    message: "GLB 轉換成功，材質包壓縮成功", 
                                    stdout: stdout,
                                    ziptype: "bzip2",
                                    fragresult: `${absoluteMaterialsPath}.frag`
                                }));
                            }
                        });

                    } else {
                        // 如果該模型本來就是純幾何、沒有任何材質貼圖
                        console.log(`[提示] 此模型未產出材質資料夾，跳過壓縮步驟。`);
                        res.statusCode = 200;
                        res.end(JSON.stringify({ 
                            status: "completed", 
                            message: "GLB 轉換成功，無材質包不必壓縮", 
                            stdout: stdout,
                            error: "No materials folder generated, skipping compression step.", // 這裡的 error 欄位只是為了讓 A 電腦能夠在收到回應後知道為什麼沒有壓縮包，而不是實際的錯誤 
                            fragresult: `${absoluteMaterialsPath}.frag`
                        }));
                    }
                });

            } catch (err) {
                res.statusCode = 400;
                res.end(JSON.stringify({ 
                    status: "error", 
                    message: "非法的 JSON 格式，請確認 Payload 結構" 
                }));
            }
        });
    } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ 
            status: "error", 
            message: "找不到此路由，請確認使用 POST /api/convert" 
        }));
    }
});

server.listen(PORT, () => {
    console.log(`================================================================`);
    console.log(`🟢 [Atomic API Server] glb-to-frag 內嵌微服務已成功啟動`);
    console.log(`   - 本地監聽埠: http://localhost:${PORT}`);
    console.log(`   - 轉檔路由點: http://localhost:${PORT}/api/convert`);
    console.log(`================================================================`);
});