# Kako - Media Steganography CLI

使用尾部追加（EOF appending）将任意文件隐藏到正常 JPG/MP4 中，不破坏宿主文件的浏览/播放能力。

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
