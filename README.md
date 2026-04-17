# Kako - Media Steganography CLI

使用容器内合法元数据字段承载（JPEG APP1/XMP-like，MP4 moov/udta/uuid+free）隐藏任意文件，
避免在文件尾部追加裸数据（trailing bytes）。
`hide` 默认会对 secret 前 20 字节做固定 XOR 混淆，以降低常见文件头签名被直接扫描命中的概率。

说明：

1. 仅支持 `.jpg/.jpeg` 与 `.mp4`。
2. `reveal` 仅支持当前容器内 `KAK3` 格式，不兼容旧 EOF 产物。
3. MP4 若已存在 Kako 元数据，二次 `hide` 会优先在 `uuid+free` 预留空间内就地更新；超容量会报错。

## Install

```bash
bun install
```

## Usage

```bash
bun run start hide -s <secret_file> -h <host_media> -o <output_file>
bun run start reveal -i <disguised_file> -d <out_dir>
```

示例：

```bash
bun run start hide -s test.txt -h cover.jpg -o safe.jpg
bun run start reveal -i safe.jpg -d ./restored
```

## Build Binary (Cross-platform)

默认构建（当前机器平台）：

```bash
bun run build
```

输出：`dist/kako`

目标发布平台：

1. `windows-x64`
2. `macos-x64` (Intel)
3. `macos-arm64` (Apple Silicon)
4. `linux-x64`

推荐一键构建发布产物：

```bash
bun run build:release
```

可直接用 Bun 手工交叉编译产物：

```bash
mkdir -p dist
bun build --compile --target=bun-windows-x64-baseline ./src/index.ts --outfile dist/kako-windows-x64.exe
bun build --compile --target=bun-darwin-x64-baseline ./src/index.ts --outfile dist/kako-macos-x64
bun build --compile --target=bun-darwin-arm64 ./src/index.ts --outfile dist/kako-macos-arm64
bun build --compile --target=bun-linux-x64-baseline ./src/index.ts --outfile dist/kako-linux-x64
```
