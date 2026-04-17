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

## Build Binary

```bash
bun run build
```

输出：`dist/kako`
