// @ts-nocheck
import { describe, expect, it } from "vitest";
import { classifyOpusDetail, extractOpusFavorite } from "@/lib/bilibili-opus.js";

/** 用图文 item 组装完整 detail 响应（与真实接口外层一致） */
function wrapDetail(item) {
  return { code: 0, data: { item, res: { code: 0 } } };
}

/** 纯图文 item：EWEADN前行者 鼠标垫宣发动态（DYNAMIC_TYPE_DRAW，默认单图） */
function drawItem(pics = [{ url: "http://i0.hdslb.com/bfs/new_dyn/pic1" }]) {
  return {
    type: "DYNAMIC_TYPE_DRAW",
    modules: {
      module_author: {
        mid: 3493259242375305,
        name: "EWEADN前行者",
        face: "http://i1.hdslb.com/bfs/face/avatar.jpg",
        pub_ts: 1769395574,
      },
      module_dynamic: {
        major: {
          opus: {
            title: "经典设计美学——前行者ES98",
            pics,
            summary: { text: "以精工细作，雕琢每一处光影与弧度" },
          },
        },
      },
      module_stat: {
        like: { count: 1129 },
        comment: { count: 1936 },
        forward: { count: 1645 },
      },
    },
  };
}

/** 纯文字 item：真实结构（vivo WORD 动态，features=itemOpusStyle 形态） */
function wordItem(text = "这套牌最后连赢8把上传说") {
  return {
    type: "DYNAMIC_TYPE_WORD",
    modules: {
      module_author: {
        mid: 22747026,
        name: "vivo",
        face: "http://i1.hdslb.com/bfs/face/vivo.jpg",
        pub_ts: 1769388888,
      },
      module_dynamic: {
        desc: null,
        major: {
          opus: {
            pics: [],
            summary: { text },
          },
        },
      },
      module_stat: {
        like: { count: 88 },
        comment: { count: 9 },
        forward: { count: 3 },
      },
    },
  };
}

describe("classifyOpusDetail：图文动态分类与归一", () => {
  it("DYNAMIC_TYPE_DRAW 纯图文 → ok，图片 http 转 https 且全量归入 images", () => {
    const out = classifyOpusDetail(
      wrapDetail(
        drawItem([
          { url: "http://i0.hdslb.com/bfs/new_dyn/pic1" },
          { url: "http://i0.hdslb.com/bfs/new_dyn/pic2" },
        ])
      )
    );
    expect(out.ok).toBe(true);
    expect(out.data.type).toBe("image");
    expect(out.data.images).toEqual([
      "https://i0.hdslb.com/bfs/new_dyn/pic1",
      "https://i0.hdslb.com/bfs/new_dyn/pic2",
    ]);
    expect(out.data.cover).toBe("https://i0.hdslb.com/bfs/new_dyn/pic1");
    expect(out.data.title).toBe("经典设计美学——前行者ES98");
    expect(out.data.desc).toBe("以精工细作，雕琢每一处光影与弧度");
    expect(out.data.author).toBe("EWEADN前行者");
    expect(out.data.authorId).toBe("3493259242375305");
    expect(out.data.authorUrl).toBe("https://space.bilibili.com/3493259242375305");
    // 头像出直链（http 已升 https）：站内图片代理是 web 出口层的事，内核不认站点路由
    expect(out.data.avatar).toBe("https://i1.hdslb.com/bfs/face/avatar.jpg");
    expect(out.data.time).toBe(1769395574);
    expect(out.data.stat).toEqual({ like: 1129, reply: 1936, share: 1645 });
  });

  it("DYNAMIC_TYPE_OPUS（新版图文）同样支持", () => {
    const out = classifyOpusDetail(
      wrapDetail({ ...drawItem(), type: "DYNAMIC_TYPE_OPUS" })
    );
    expect(out.ok).toBe(true);
    expect(out.data.images.length).toBeGreaterThan(0);
  });

  it("DYNAMIC_TYPE_ARTICLE（专栏文章）→ 拒绝并提示专栏", () => {
    const out = classifyOpusDetail(
      wrapDetail({ ...drawItem(), type: "DYNAMIC_TYPE_ARTICLE" })
    );
    expect(out.ok).toBe(false);
    expect(out.msg).toContain("专栏");
  });

  it("纯文字动态（DYNAMIC_TYPE_WORD）→ type=text，正文取 opus.summary.text", () => {
    const out = classifyOpusDetail(wrapDetail(wordItem()));
    expect(out.ok).toBe(true);
    expect(out.data.type).toBe("text");
    expect(out.data.desc).toBe("这套牌最后连赢8把上传说");
    expect(out.data.cover).toBeUndefined();
    expect(out.data.images).toBeUndefined();
    expect(out.data.author).toBe("vivo");
    expect(out.data.authorId).toBe("22747026");
    expect(out.data.authorUrl).toBe("https://space.bilibili.com/22747026");
    expect(out.data.avatar).toBe("https://i1.hdslb.com/bfs/face/vivo.jpg");
    expect(out.data.time).toBe(1769388888);
    expect(out.data.stat).toEqual({ like: 88, reply: 9, share: 3 });
  });

  it("DRAW 无图但带文案 → 同样按纯文字返回", () => {
    const item = drawItem([]);
    const out = classifyOpusDetail(
      wrapDetail({
        ...item,
        modules: {
          ...item.modules,
          module_dynamic: {
            major: { opus: { pics: [], summary: { text: "无图动态正文" } } },
          },
        },
      })
    );
    expect(out.ok).toBe(true);
    expect(out.data.type).toBe("text");
    expect(out.data.desc).toBe("无图动态正文");
  });

  it("无 features 形态（major 为空）→ 正文回退 module_dynamic.desc.text", () => {
    const item = wordItem();
    const out = classifyOpusDetail(
      wrapDetail({
        ...item,
        modules: {
          ...item.modules,
          module_dynamic: { major: null, desc: { text: "旧形态正文" } },
        },
      })
    );
    expect(out.ok).toBe(true);
    expect(out.data.type).toBe("text");
    expect(out.data.desc).toBe("旧形态正文");
  });

  it("无图且无正文（空动态）→ 拒绝", () => {
    const out = classifyOpusDetail(wrapDetail(wordItem("")));
    expect(out.ok).toBe(false);
    expect(out.msg).toContain("文字或图片");
  });

  it("视频/其它动态类型 → 拒绝并提示暂不支持", () => {
    const out = classifyOpusDetail(
      wrapDetail({ ...drawItem(), type: "DYNAMIC_TYPE_AV" })
    );
    expect(out.ok).toBe(false);
    expect(out.msg).toContain("图文或文字");
  });

  it("detail 缺失 item（接口异常）→ 解析失败", () => {
    expect(classifyOpusDetail({ code: -352, message: "风控" })).toEqual({
      ok: false,
      msg: "解析失败！",
    });
  });
});

describe("extractOpusFavorite：opus/detail 收藏数提取", () => {
  const wrap = (modules) => ({ code: 0, data: { item: { modules } } });

  it("从 MODULE_TYPE_STAT 项的 module_stat.favorite.count 取收藏数", () => {
    const payload = wrap([
      { module_type: "MODULE_TYPE_TITLE", module_stat: null },
      {
        module_type: "MODULE_TYPE_STAT",
        module_stat: {
          like: { count: 1129 },
          favorite: { count: 19 },
        },
      },
    ]);
    expect(extractOpusFavorite(payload)).toBe(19);
  });

  it("收藏数为 0 / 缺失 / 结构不符 → undefined（无源不造数）", () => {
    expect(
      extractOpusFavorite(wrap([{ module_stat: { favorite: { count: 0 } } }]))
    ).toBeUndefined();
    expect(
      extractOpusFavorite(wrap([{ module_stat: { favorite: null } }]))
    ).toBeUndefined();
    expect(extractOpusFavorite(wrap([]))).toBeUndefined();
    expect(extractOpusFavorite({ code: -352, message: "风控" })).toBeUndefined();
  });
});
