"use client";
import { useState } from "react";
import Image, { type ImageProps } from "next/image";
import { imageUrlCandidates } from "@/utils/proxiedImage";

/**
 * 经站内图片代理加载的 `<Image>`：代理地址失败时自动回退裸直链。
 *
 * 存在理由：出口层把所有图片字段统一包成 `/api/image?url=…`（同源化 + 补防盗链
 * Referer），但代理要服务端回源，跨境部署下图床回源可能比用户浏览器直连还慢甚至被
 * 中间层掐断——此时没有兜底就是一整块空白。代理与直链的取舍交给加载结果，不靠猜。
 *
 * `src` 两种形态都收：出口改写后的代理串，以及尚未改写的裸直链（后者先包代理再回退）。
 * 固定 `unoptimized`：站内已禁用图片优化器，代理串上的 query 也不该被优化器重写。
 * `onError` 语义随之改变：不是「本次 src 加载失败」，而是「代理与直链全部失败」，
 * 骨架屏一类的兜底 UI 应当挂在这上面。
 */
type ProxiedImageProps = Omit<
  ImageProps,
  "src" | "unoptimized" | "onError"
> & {
  /** 代理串或裸直链都收 */
  src: string;
  /** 代理与直链全部加载失败时回调（不带事件参数） */
  onError?: () => void;
};

export default function ProxiedImage({
  src,
  alt,
  onError,
  ...rest
}: ProxiedImageProps) {
  const candidates = imageUrlCandidates(src);
  // 记住「哪个候选已经失败」而不是「第几个」：换图（切分P / 重新解析）时候选整个变样，
  // 失败项自然不再命中，无需 effect 重置，也不会用上一次失败的位置渲染新图。
  const [failed, setFailed] = useState<string | null>(null);
  const current =
    candidates.find((url) => url !== failed) ??
    candidates[candidates.length - 1] ??
    "";

  return (
    <Image
      {...rest}
      src={current}
      alt={alt}
      unoptimized
      onError={() => {
        const next = candidates.find((url) => url !== current && url !== failed);
        if (next) setFailed(current);
        else onError?.();
      }}
    />
  );
}
