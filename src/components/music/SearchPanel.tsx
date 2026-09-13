"use client";

import type { CSSProperties, Dispatch, FormEvent, SetStateAction } from "react";
import { AlertCircle, Link2, Loader2, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SearchSourceKey } from "@/components/music/types";
import { AggregateIcon, PlatformIcon } from "@/components/music/platform-icons";
import type { SearchChip } from "./source-meta";
import { platformBrandFor } from "./platform-brand";

export interface SearchPanelProps {
  mode: "search" | "resolve";
  setMode: Dispatch<SetStateAction<"search" | "resolve">>;
  keyword: string;
  setKeyword: Dispatch<SetStateAction<string>>;
  link: string;
  setLink: Dispatch<SetStateAction<string>>;
  searching: boolean;
  resolving: boolean;
  searchError: string;
  resolveError: string;
  setSearchError: Dispatch<SetStateAction<string>>;
  setResolveError: Dispatch<SetStateAction<string>>;
  source: SearchSourceKey;
  /** 全部可选的搜索源 chip（内置 GD 源 + 自研直连搜索源） */
  sourceChips: SearchChip[];
  /** 当前搜索源的展示名（如“我的网易云源”），用于搜索框占位 */
  sourceLabel: string;
  /** 聚合搜索模式：一次并发搜索全部音源，跨源合并去重 + 按相关度打分排序 */
  aggActive: boolean;
  setAggActive: Dispatch<SetStateAction<boolean>>;
  runSearch: (arg?: FormEvent<HTMLFormElement> | string) => void;
  runResolve: (arg?: FormEvent<HTMLFormElement>) => void;
  switchSource: (next: SearchSourceKey) => void;
  /** 最近搜索关键词（本机缓存，最新在前）；空数组时整行不展示 */
  history: string[];
  /** 删除一条搜索历史 */
  onRemoveHistory: (kw: string) => void;
  /** 清空全部搜索历史 */
  onClearHistory: () => void;
}

/**
 * 发现歌曲页的搜索面板：关键词搜索 / 粘贴链接解析 两个模式的表单、
 * 音源 chip 行、热门标签与错误提示。纯受控展示组件，交互回调来自父级。
 */
export default function SearchPanel({
  mode,
  setMode,
  keyword,
  setKeyword,
  link,
  setLink,
  searching,
  resolving,
  searchError,
  resolveError,
  setSearchError,
  setResolveError,
  source,
  sourceChips,
  sourceLabel,
  aggActive,
  setAggActive,
  runSearch,
  runResolve,
  switchSource,
  history,
  onRemoveHistory,
  onClearHistory,
}: SearchPanelProps) {
  const tags = ["周杰伦", "林俊杰", "陈奕迅", "Beyond", "稻香"];
  const searchMode = mode === "search";
  const switchMode = (next: "search" | "resolve") => {
    if (next === mode) return;
    setMode(next);
    setResolveError("");
    setSearchError("");
  };
  return (
    <div className="mp-scroll">
      <div className="mp-hero">
        <h1>{searchMode ? "发现好音乐" : "链接直达歌曲"}</h1>
        <p className="mp-hero-sub">
          {searchMode
            ? "统一接入多个音源，搜索即试听，一点即下载"
            : "粘贴歌曲分享链接，一步解析成可试听 / 下载的曲目"}
        </p>

        <div className="mp-mode-seg" role="tablist" aria-label="歌曲查找方式">
          <button
            type="button"
            role="tab"
            aria-selected={searchMode}
            className={cn("mp-mode-btn", searchMode && "is-active")}
            onClick={() => switchMode("search")}>
            <Search />
            关键词搜索
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={!searchMode}
            className={cn("mp-mode-btn", !searchMode && "is-active")}
            onClick={() => switchMode("resolve")}>
            <Link2 />
            粘贴链接解析
          </button>
        </div>

        {searchMode ? (
          <>
            <form className="mp-search-big" onSubmit={runSearch}>
              <Search />
              <input
                value={keyword}
                onChange={(e) => {
                  setKeyword(e.target.value);
                  if (searchError) setSearchError("");
                }}
                placeholder={
                  aggActive
                    ? "聚合搜索全部音源：歌名 / 歌手（并集去重 + 相关度排序）"
                    : `在 ${sourceLabel} 中搜索歌曲 / 歌手`
                }
                autoComplete="off"
              />
              <button
                type="submit"
                title="搜索"
                disabled={searching || !keyword.trim()}>
                {searching ? <Loader2 className="mp-spin" /> : <Search />}
              </button>
            </form>

            <div className="mp-chiprow">
              {/* 聚合搜索伪 chip：一次搜全部音源（独立于单源 chip，不写入 source 状态）；
                  图标为 /logos/aggregate.svg 的「多源汇聚」图示，与平台 logo 同为 14px */}
              <button
                type="button"
                aria-pressed={aggActive}
                title="聚合搜索：一次搜索全部音源，跨源合并去重并按相关度排序展示"
                className={cn("mp-src-chip", "mp-src-chip-agg", aggActive && "is-active")}
                style={{ "--sc": "var(--mp-primary)" } as CSSProperties}
                onClick={() => setAggActive(!aggActive)}>
                <AggregateIcon />
                聚合搜索
              </button>
              {sourceChips.map((s) => {
                // 聚合模式下列表来源混合，source 仅是“退出聚合后的回退值”，不视为当前选中
                const active = !aggActive && source === s.key;
                // 有品牌 SVG 的平台（含自研直连源 kugou / migu / tencent）渲染 logo，
                // 无品牌的退回品牌色圆点 —— 以 brand 数据为准，不按通道硬编码
                const hasLogo = Boolean(platformBrandFor(s.key).logo);
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => switchSource(s.key)}
                    title={
                      s.self
                        ? `自研直连搜索 · ${s.label}（站点直连音源，不经 GD 上游）`
                        : `切到 ${s.label}`
                    }
                    className={cn(
                      "mp-src-chip",
                      active && "is-active",
                      s.self && "mp-src-chip-self"
                    )}
                    style={{ "--sc": s.color } as CSSProperties}>
                    {hasLogo ? (
                      <PlatformIcon source={s.key} />
                    ) : (
                      <span className="dot" aria-hidden="true" />
                    )}
                    {s.label}
                  </button>
                );
              })}
            </div>

            {!searching && (
              <>
                {/* 最近搜索（本机缓存，见 search-history.ts）：点词回填重搜、单个可删、行尾可清空。
                    与热门标签同处搜索框之下，故并进同一个 !searching 分支 */}
                {history.length > 0 && (
                  <div className="mp-hist">
                    <span className="mp-hist-cap">最近搜索</span>
                    {history.map((kw) => (
                      <span key={kw} className="mp-hist-chip">
                        <button
                          type="button"
                          className="mp-hist-kw"
                          title={`再次搜索「${kw}」`}
                          onClick={() => runSearch(kw)}>
                          {kw}
                        </button>
                        <button
                          type="button"
                          className="mp-hist-del"
                          aria-label={`删除历史记录「${kw}」`}
                          title="删除这条历史"
                          onClick={() => onRemoveHistory(kw)}>
                          <X />
                        </button>
                      </span>
                    ))}
                    <button
                      type="button"
                      className="mp-hist-clear"
                      onClick={onClearHistory}>
                      清空
                    </button>
                  </div>
                )}

                <div className="mp-tags">
                  {tags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className="mp-tag"
                      onClick={() => runSearch(tag)}>
                      {tag}
                    </button>
                  ))}
                </div>
              </>
            )}

            {searchError && (
              <div
                className="mp-error"
                style={{ width: "min(520px,100%)", marginTop: 14 }}>
                <AlertCircle />
                <span>{searchError}</span>
              </div>
            )}
          </>
        ) : (
          <>
            <form className="mp-search-big mp-link-form" onSubmit={runResolve}>
              <Link2 />
              <input
                value={link}
                onChange={(e) => {
                  setLink(e.target.value);
                  if (resolveError) setResolveError("");
                }}
                placeholder="粘贴歌曲分享链接，如 https://music.163.com/song?id=…"
                autoComplete="off"
                spellCheck={false}
                inputMode="url"
              />
              <button
                type="submit"
                title="解析歌曲"
                disabled={resolving || !link.trim()}>
                {resolving ? <Loader2 className="mp-spin" /> : <Link2 />}
              </button>
            </form>

            <p className="mp-resolve-tip">
              支持：<strong>网易云音乐 / QQ音乐 / 酷我音乐</strong> 歌曲链接直接解析播放；
              <span className="dim">
                酷狗歌曲链接可识别，直链引擎接入后开放
              </span>
            </p>

            {resolveError && (
              <div
                className="mp-error"
                style={{ width: "min(560px,100%)", marginTop: 12 }}>
                <AlertCircle />
                <span>{resolveError}</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
