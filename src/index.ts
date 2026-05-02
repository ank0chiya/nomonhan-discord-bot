import { InteractionType, InteractionResponseType, verifyKey } from "discord-interactions";

export interface Env {
    DISCORD_PUBLIC_KEY: string;
    DISCORD_WEBHOOK_URL: string;
    REMINDERS: KVNamespace;
}

async function verifyDiscordRequest(request: Request, env: Env) {
    const signature = request.headers.get("x-signature-ed25519");
    const timestamp = request.headers.get("x-signature-timestamp");
    if (!signature || !timestamp) return { isValid: false, interaction: null };
    const bodyText = await request.text();
    const isValid = await verifyKey(bodyText, signature, timestamp, env.DISCORD_PUBLIC_KEY);
    if (!isValid) return { isValid: false, interaction: null };
    return { isValid: true, interaction: JSON.parse(bodyText) };
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const { isValid, interaction } = await verifyDiscordRequest(request, env);
        if (!isValid) return new Response("Invalid signature", { status: 401 });

        if (interaction.type === InteractionType.PING) {
            return new Response(JSON.stringify({ type: InteractionResponseType.PONG }), { headers: { "Content-Type": "application/json" } });
        }

        if (interaction.type === InteractionType.APPLICATION_COMMAND) {
            const commandName = interaction.data.name;
            const options = interaction.data.options || [];

            // 1. /remind コマンド
            if (commandName === "remind") {
                const dateInput = options.find((o: any) => o.name === "date").value;
                const timeOption = options.find((o: any) => o.name === "time");
                const messageOption = options.find((o: any) => o.name === "message");

                const timeInput = timeOption?.value || "09:00";
                const customMsg = messageOption?.value || "予定の日です！お忘れなく。";

                let remindDateTime = new Date(`${dateInput}T${timeInput}:00+09:00`);

                if (!timeOption) {
                    remindDateTime.setDate(remindDateTime.getDate() - 1);
                } 

                const now = new Date();
                if (remindDateTime.getTime() <= now.getTime()) {
                    return new Response(JSON.stringify({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: { content: `❌ エラー: 設定しようとした時刻（${remindDateTime.toLocaleString('ja-JP', {timeZone: 'Asia/Tokyo'})}）は既に過ぎています。` }
                    }), { headers: { "Content-Type": "application/json" } });
                }

                const remindKey = `remind:${remindDateTime.toISOString().substring(0, 16)}`;
                await env.REMINDERS.put(remindKey, JSON.stringify({ 
                    eventDate: dateInput, 
                    message: customMsg,
                    isSameDay: !!timeOption
                }));

                const displayTime = remindDateTime.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
                const modeText = timeOption ? "指定日時ぴったり" : "予定前日の朝";

                return new Response(JSON.stringify({
                    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    data: { content: `✅ リマインドを予約しました！ (${modeText})\n📅 通知日時: **${displayTime}**\n💬 内容: ${customMsg}` }
                }), { headers: { "Content-Type": "application/json" } });
            }

            // 2. /list-reminders コマンド
            if (commandName === "list-reminders") {
                const list = await env.REMINDERS.list({ prefix: "remind:" });
                
                if (list.keys.length === 0) {
                    return new Response(JSON.stringify({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: { content: "現在予約中のリマインドはありません。" }
                    }), { headers: { "Content-Type": "application/json" } });
                }

                let responseText = "📋 **現在予約中のリマインド一覧:**\n\n";
                for (const key of list.keys) {
                    const rawData: any = await env.REMINDERS.get(key.name);
                    let messageContent = "";
                    
                    try {
                        const parsed = JSON.parse(rawData);
                        messageContent = parsed.message;
                    } catch (e) {
                        messageContent = `（古い形式のデータ）: ${rawData}`;
                    }
                    
                    const utcString = key.name.replace("remind:", "") + ":00Z";
                    const jstTime = new Date(utcString).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
                    
                    responseText += `🆔 ID: \`${key.name}\`\n⏰ 通知日時: ${jstTime}\n💬 内容: ${messageContent}\n\n`;
                }
                responseText += "※ キャンセルするには `/cancel id: [上に表示されているID]` を入力してください。";

                return new Response(JSON.stringify({
                    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    data: { content: responseText }
                }), { headers: { "Content-Type": "application/json" } });
            }

            // 3. /cancel コマンド
            if (commandName === "cancel") {
                const targetKey = options.find((o: any) => o.name === "id").value;
                
                const existing = await env.REMINDERS.get(targetKey);
                if (!existing) {
                    return new Response(JSON.stringify({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: { content: `❌ エラー: ID \`${targetKey}\` が見つかりませんでした。` }
                    }), { headers: { "Content-Type": "application/json" } });
                }

                await env.REMINDERS.delete(targetKey);
                return new Response(JSON.stringify({
                    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    data: { content: `🗑️ リマインドをキャンセルしました。\nキャンセルしたID: \`${targetKey}\`` }
                }), { headers: { "Content-Type": "application/json" } });
            }
        }

        return new Response("Unknown interaction", { status: 400 });
    },

    // ----------------------------------------------------
    // 定期実行 (1分ごと): 取りこぼし防止仕様
    // ----------------------------------------------------
    async scheduled(event: any, env: Env, ctx: any) {
        const now = new Date();

        // 1. まず「remind:」から始まるキーを全部持ってくる
        const list = await env.REMINDERS.list({ prefix: "remind:" });

        for (const key of list.keys) {
            // 2. キー名から時間を復元する (例: "remind:2026-05-02T04:00" -> "2026-05-02T04:00:00Z")
            const utcString = key.name.replace("remind:", "") + ":00Z";
            const remindTime = new Date(utcString);

            // 3. 予定の時間が「現在時刻と同じ」または「過去」になっているか判定
            if (remindTime.getTime() <= now.getTime()) {
                
                // 条件を満たしていれば中身を取得して送信
                const data: any = await env.REMINDERS.get(key.name);
                if (data) {
                    let messageContent = data; 
                    try {
                        const parsed = JSON.parse(data);
                        messageContent = parsed.message;
                    } catch (e) {
                        // 古いデータ形式のフォールバック
                    }

                    await fetch(env.DISCORD_WEBHOOK_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            content: `@everyone 【リマインド】\n${messageContent}` 
                        }),
                    });

                    // 4. 無事に送信できたらKVから削除する
                    await env.REMINDERS.delete(key.name);
                }
            }
        }
    },
};