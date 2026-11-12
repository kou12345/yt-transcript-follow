# YouTube Transcript Follow

YouTube の再生位置に合わせて、Obsidian ノートの文字起こしを Chrome のサイドパネルで自動スクロールする拡張機能。

## インストール

1. `chrome://extensions` でデベロッパーモードを ON
2. 「パッケージ化されていない拡張機能を読み込む」でこのフォルダを選択
3. 開いていた YouTube タブは再読み込みする

## 使い方

1. 拡張アイコンからサイドパネルを開き、「Vault を選択」で Obsidian Vault のフォルダを選ぶ
2. YouTube で動画を再生すると、frontmatter の `source:` にその動画 ID を含むノートを自動で開く
3. 段落クリックでその時刻へシーク。手動スクロールすると追従が止まり、「現在位置に戻る」で再開

ブラウザ再起動後は「再接続」ボタンで Vault の読み取りを再許可する。

## ノートの形式

```markdown
---
source: https://www.youtube.com/watch?v=VIDEO_ID
---

## Transcript

### 章見出し

**0:13**

本文（複数行可）

**1:02:22**

...
```

`## Transcript` 以降の `**M:SS**` / `**H:MM:SS**` 行をタイムスタンプとして扱う。
