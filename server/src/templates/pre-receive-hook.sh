#!/bin/sh
#
# pre-receive hook: プッシュの検査はすべて push-check (TypeScript) が行う。
#   server/src/lib/push-check/  シークレット / 実行設定ファイル(PROTECTED_CONFIG) /
#   自動実行を含むスキル / 個人用フォルダ(PERSONAL_PATH) / 書き込み権限(WRITE_DENIED) /
#   Windows非互換パス / gitlink
# このファイルはその呼び出しだけを行う。サーバー(lib/git-server)が起動時に
# 全リポジトリへ配置し直し、@@...@@ の部分をサーバー自身の node・tsx・
# 検査プログラムの絶対パスに置き換える。
#
# 検査プログラムを実行できない・途中で失敗した場合は、変更を確認できないので
# 拒否する（[HOOK_ERROR]。クライアントは「送信失敗・次回再試行」として扱う）。

# ロケールを固定する（バイト単位の C ロケール）。検査は git の出力をバイト列の
# まま扱うが、git 自身の出力（メッセージ・引用符付きのパス）も環境に依らない
# ようにする。NODE_OPTIONS はサーバーの起動方法によって変わるので引き継がない。
export LC_ALL=C
unset LANGUAGE NODE_OPTIONS
export NODE_NO_WARNINGS=1

# 検査に使う node: ACB_NODE（git-http.ts がサーバー自身の node を渡す）、
# 無ければ・実行できなければ、インストール時のサーバーの node、それも無ければ PATH の node。
runnable() {
  case "$1" in
    */*) [ -f "$1" ] && [ -x "$1" ] ;;
    ?*) command -v "$1" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}
acb_node=@@ACB_SERVER_NODE@@
if runnable "${ACB_NODE:-}"; then
  acb_node=$ACB_NODE
elif ! runnable "$acb_node"; then
  acb_node=node
fi

"$acb_node" --import @@ACB_TSX_LOADER@@ @@ACB_PUSH_CHECK@@
status=$?

# 0 = 受け入れ、10 = 拒否（理由は検査プログラムが出力済み）、それ以外 = 検査できなかった
case $status in
  0) exit 0 ;;
  10) exit 1 ;;
esac
echo "[HOOK_ERROR] サーバーで変更内容を確認できませんでした（検査プログラムの終了コード: $status）。時間をおいて再度同期してください" >&2
exit 1
