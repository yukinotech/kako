# Idea 1: 如何伪装 MP4 文件体积

## 背景

当前 Kako 的 MP4 隐写方式是把 secret payload 写入 MP4 容器内的合法 box：

- `moov/udta/uuid` 承载 Kako payload
- `free` 作为后续覆盖更新的预留空间

这个方案不会重新编码视频，也不会压缩 secret。因此输出文件大小大致等于：

```text
原始 MP4 大小 + secret 大小 + Kako 头/CRC/box 开销 + free 预留空间
```

如果用一个 5 秒 MP4 承载几个 GB 的 secret，最终文件会表现为“5 秒视频却有几个 GB”，外观上非常不合理。

更合理的伪装方向是：先构造一个“时长很长，但画面数据很小”的 MP4 cover，再把 secret 写入该 MP4。这样最终文件虽然仍然包含完整 secret 数据，但在外观上更像一个正常的大体积长视频。

## 核心结论

“1 小时但文件很小”的 MP4 通常不是因为 MP4 容器可以通用地引用同一段视频数据循环播放 N 次，而是因为视频编码器能把静态画面或重复画面压得非常小。

常见原因：

- 静态图或低变化画面只需要少量关键帧。
- 后续帧可以通过预测帧表达，数据量很小。
- 低帧率、较高 CRF、无音轨可以进一步降低视频轨体积。

因此，构造流程的重点不是修改 MP4 duration 字段制造“伪时长”，而是用正常编码方式生成一个真实可播放、时长足够长、码率很低的 MP4。

## 推荐构造方式一：单张图生成长视频

适合做最小体积的 cover。画面完全静态，播放器兼容性最好。

```bash
ffmpeg -y \
  -loop 1 -framerate 1 -i cover.jpg \
  -t 01:00:00 \
  -vf "scale=1280:-2,format=yuv420p" \
  -c:v libx264 \
  -preset veryslow \
  -crf 34 \
  -tune stillimage \
  -an \
  -movflags +faststart \
  cover_1h.mp4
```

参数说明：

- `-loop 1`：让单张图片作为无限输入。
- `-framerate 1`：输入按 1 FPS 生成，降低帧数量。
- `-t 01:00:00`：输出显示为 1 小时。
- `-vf "scale=1280:-2,format=yuv420p"`：统一分辨率并提高播放器兼容性。
- `-c:v libx264`：使用 H.264 编码。
- `-preset veryslow`：用更慢编码换更小体积。
- `-crf 34`：较高压缩率。数值越大，体积越小，画质越差。
- `-tune stillimage`：针对静态图优化。
- `-an`：移除音轨。
- `-movflags +faststart`：把 `moov` 前置，提升播放兼容性。

生成 cover 后再执行 Kako 隐写：

```bash
bun run start hide -s secret.bin -h cover_1h.mp4 -o output.mp4
```

## 推荐构造方式二：短视频循环成长视频

适合需要画面有轻微变化的 cover。比如一个 5 秒循环素材重复到 1 小时。

```bash
ffmpeg -y \
  -stream_loop -1 -i loop5s.mp4 \
  -t 01:00:00 \
  -vf "scale=1280:-2,format=yuv420p" \
  -c:v libx264 \
  -preset veryslow \
  -crf 32 \
  -an \
  -movflags +faststart \
  cover_1h.mp4
```

参数说明：

- `-stream_loop -1`：无限循环输入短视频。
- `-t 01:00:00`：截取成 1 小时输出。
- `-crf 32`：循环视频比静态图变化更多，CRF 可略低一些。
- `-an`：去掉原始音轨，避免音频数据把体积拉大。

如果需要保留音频，应该明确控制音频码率，例如：

```bash
-c:a aac -b:a 64k
```

但音频会稳定增加体积。1 小时 64 kbps 音轨约为 28 MB。

## 为什么不要只改 duration 字段

理论上可以尝试修改 MP4 的 `mvhd`、`tkhd`、`mdhd` duration，或通过 edit list 让播放器显示更长时长。但这不是推荐方案。

风险：

- 不同播放器行为不一致。
- 可能显示很长，但实际播放很快结束。
- 可能拖动进度条异常。
- 可能被工具重新解析后暴露轨道样本和 duration 不匹配。
- 对 Kako 当前的 box 改写逻辑也会增加额外复杂度。

相比之下，正常编码一个低码率长视频更稳定，也更符合 MP4 文件的常规结构。

## 与 Kako 的关系

Kako 当前写入的是容器元数据，不会改变视频画面内容。

因此推荐流程是：

```text
准备一张图片或一个短循环视频
        ↓
用 ffmpeg 生成长时长、低码率 MP4 cover
        ↓
用 Kako hide 写入 secret
        ↓
得到一个显示为长视频、文件体积更合理的 MP4
```

需要注意：

- 这个方法不会压缩 secret。
- secret 有多大，最终 MP4 至少会增加接近多少体积。
- 它解决的是“视频时长和文件大小不匹配”的外观问题。
- 如果要隐藏 GB 级 secret，cover 的时长应相应拉长，例如 1 小时、2 小时或更长。

## 体积合理性估算

可以用目标总文件大小除以视频时长来估算外观码率：

```text
平均码率 Mbps = 文件大小 MB * 8 / 时长秒
```

例如：

```text
3 GB / 1 小时 ≈ 6.8 Mbps
```

这对 1080p 长视频来说是合理范围。

但：

```text
3 GB / 5 秒 ≈ 4915 Mbps
```

这明显不合理。

因此，对于大 payload，不应该使用几秒钟 cover，而应该构造一个足够长的低码率 cover。

## 后续可落地功能

可以给 Kako 增加一个辅助命令，例如：

```bash
kako make-cover --image cover.jpg --duration 01:00:00 --output cover_1h.mp4
```

或：

```bash
kako make-cover --loop loop5s.mp4 --duration 01:00:00 --output cover_1h.mp4
```

也可以在 `hide` 前增加合理性检查：

- 读取 host MP4 duration。
- 读取 secret 大小。
- 估算输出文件平均码率。
- 如果码率明显异常，提示用户先生成更长的 cover。

这不会改变隐写算法本身，但能显著改善输出文件的伪装合理性。
