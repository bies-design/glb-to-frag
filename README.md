# GLB to FRAG Converter

這個專案用 Node.js / TypeScript 將 `.glb` 轉成 ThatOpen Fragments 可讀的 `.frag`，並同時輸出材質 sidecar package。

目前 pipeline 會做：

```txt
GLB
-> IR JSON
-> deflated .frag
-> frag verify
-> material sidecar package
```

## 環境需求

需要先安裝：

```txt
Node.js 20+
npm
```

專案目前使用 glTF Transform 讀取 GLB，並支援 Draco-compressed GLB：

```txt
KHR_draco_mesh_compression
```

## 安裝

在專案根目錄執行：

```bash
npm install
```

## 建置

```bash
npm run build
```

build 後會產生：

```txt
dist/
```

## 一鍵轉檔

使用 pipeline：

```bash
npm run pipeline -- C:\path\to\input.glb C:\path\to\output
```

注意：

```txt
第一個參數必須是 GLB 絕對路徑
第二個參數必須是輸出資料夾絕對路徑
```

例如：

```bash
npm run pipeline -- C:\Users\Shendy\Desktop\glb-to-frag-test\testSM.glb C:\Users\Shendy\Desktop\glb-output
```

如果輸入是：

```txt
testSM.glb
```

會輸出：

```txt
glb-output/
  testSM.ir.json
  testSM.frag

  testSM/
    testSM.materials.json
    textures/
    uv/
      triangle-expanded-uvs.bin
```

## Pipeline 流程

`npm run pipeline` 內部依序執行：

```txt
1. glb-to-ir
2. ir-to-frag
3. frag-verify
4. glb-extract-assets
```

也就是：

```bash
node dist/glb-to-ir.js input.glb output/name.ir.json
node dist/ir-to-frag.js output/name.ir.json output/name.frag
node dist/frag-verify.js output/name.frag
node dist/glb-extract-assets.js input.glb output/name
```

如果其中任一步失敗，pipeline 會中斷並回傳錯誤。

材質包會在 `.frag` 成功產出並通過 `frag-verify` 後才輸出。

## 輸出說明

### `.frag`

```txt
name.frag
```

這是 deflated FlatBuffers `.frag` binary，可交給目前 viewer 載入。

### `.ir.json`

```txt
name.ir.json
```

中間資料，用於 debug 或重新輸出 `.frag`。

大型模型的 IR 可能很大。

### 材質包

```txt
name/
  name.materials.json
  textures/
  uv/
    triangle-expanded-uvs.bin
```

材質包給 viewer sidecar material loader 使用。

`textures/` 會保存 GLB 中抽出的 texture 圖片。

`uv/triangle-expanded-uvs.bin` 保存攤平後的 UV binary buffer，避免把大量 UV values 放進 JSON。

## Viewer 使用方式

如果 pipeline 輸出是：

```txt
output/
  building.frag
  building/
    building.materials.json
```

viewer 端應該：

```txt
載入 output/building.frag
Material Root 選 output/
```

viewer 會依照 `.frag` 檔名找：

```txt
output/building/building.materials.json
```

## 單步工具

### GLB smoke test

確認 Node.js / glTF Transform 能讀 GLB：

```bash
node dist/glb-smoke-test.js input.glb
```

會輸出：

```txt
scene count
node count
mesh count
primitive count
position count
index count
material count
```

### GLB metadata inspect

檢查 GLB 是否有 name / extras / extensions / node hierarchy：

```bash
node dist/glb-inspect-metadata.js input.glb output.metadata.json
```

用途：

```txt
找 Rhino layer / category / object metadata 是否存在
檢查 node hierarchy 是否可轉 spatial tree
```

### GLB to IR

```bash
node dist/glb-to-ir.js input.glb output.ir.json
```

會輸出幾何、材質 fallback、transform、bbox、stats，以及 `spatialTree`。

### IR to FRAG

指定 output：

```bash
node dist/ir-to-frag.js input.ir.json output.frag
```

不指定 output 時，會輸出到 IR 同層的 `frag/` 資料夾：

```bash
node dist/ir-to-frag.js input.ir.json
```

例如：

```txt
input:  chair.ir.json
output: frag/chair.frag
```

### FRAG verify

```bash
node dist/frag-verify.js output.frag
```

會確認 `.frag` 可被 FlatBuffers reader 讀回，並輸出：

```txt
encoding
local_ids.length
meshes.samples.length
meshes.shells.length
meshes.shells.points.length total
meshes.shells.profiles.length total
spatial_structure.nodes.length total
spatial_structure.local_ids.length total
```

### Extract material assets

指定 output：

```bash
node dist/glb-extract-assets.js input.glb output-dir
```

不指定 output 時，會輸出到 GLB 同層：

```txt
材質包/name/
```

例如：

```bash
node dist/glb-extract-assets.js chair.glb
```

輸出：

```txt
材質包/
  chair/
    chair.materials.json
    textures/
    uv/
      triangle-expanded-uvs.bin
```

## Spatial Structure

目前 `.frag` 會寫入 `Model.spatial_structure`。

來源是 GLB 的 scene/node hierarchy：

```txt
scene
  named container node
    mesh node
```

轉換規則：

```txt
沒有 mesh 的 node
-> spatial container
-> localId = null
-> category = node.name

有 mesh 的 node
-> spatial item
-> localId = item.localId
-> category = item.category
```

viewer 的 ModelStructureSidebar 可以透過這棵 tree 收集 localIds，進行 highlight / hide / isolate。

## 常見錯誤

### Missing required extension, "KHR_draco_mesh_compression"

代表 GLB 使用 Draco 壓縮，但 reader 沒有註冊 Draco decoder。

目前專案已透過 `src/gltf-io.ts` 註冊 Draco decoder。

### Invalid string length

通常代表 JSON 太大。

大型模型請使用：

```txt
glb-to-ir -> ir-to-frag
```

不要走：

```txt
ir-to-fraglike
```

### incorrect header check

代表 viewer 嘗試 inflate 一個非 deflated 檔案。

目前 `ir-to-frag` 輸出預設是 deflated `.frag`。

### Viewer 材質沒有貼對

請確認：

```txt
材質包 name 是否跟 frag 檔名一致
name.materials.json 是否存在
uv/triangle-expanded-uvs.bin 是否存在
viewer 的 Material Root 是否選到 output 根目錄
```

## Git 注意事項

轉檔產物已加入 `.gitignore`，不要提交：

```txt
*.glb
*.frag
*.ir.json
*.fraglike.json
*.metadata.json
*.materials.json
frag/
材質包/
textures/
uv/
```

`fragment.fbs` 是 schema 來源，應該保留在 Git。
