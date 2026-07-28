require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const { GoogleGenAI } = require('@google/genai');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// مقداردهی هوش مصنوعی Gemini و ربات تلگرام
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// --- Admin List ---
const ADMIN_IDS = new Set(["97660313", "108265666", "6190801722"]);
const isAdmin = (id) => ADMIN_IDS.has(String(id));

// --- DB Logic (JSONBin.io) ---
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${process.env.JSONBIN_ID}`;
const JSONBIN_HEADERS = {
    "Content-Type": "application/json",
    "X-Master-Key": process.env.JSONBIN_API_KEY
};

async function getDB() {
    try {
        const response = await fetch(JSONBIN_URL, { 
            headers: {
                ...JSONBIN_HEADERS,
                "X-Bin-Meta": "false"
            } 
        });
        if (!response.ok) throw new Error(`DB Fetch Failed: ${response.statusText}`);
        const data = await response.json();

        const db = data || {};
        if (!db.allowedUserIds) db.allowedUserIds = [];
        if (!db.users) db.users = {};

        return db;
    } catch (err) {
        console.error('❌ DB Load Error:', err);
        return { allowedUserIds: [], users: {} };
    }
}

async function saveDB(data) {
    try {
        const response = await fetch(JSONBIN_URL, {
            method: 'PUT',
            headers: {
                ...JSONBIN_HEADERS,
                "X-Bin-Meta": "false"
            },
            body: JSON.stringify(data)
        });
        return response.ok;
    } catch (err) {
        console.error("❌ DB Save Error:", err);
        return false;
    }
}

const DEFAULT_LIMIT = 8;

function ensureUser(db, userId) {
    if (!db.users) db.users = {};
    let migrated = false;

    if (!db.users[userId]) {
        db.users[userId] = { count: 0, limit: DEFAULT_LIMIT };
        migrated = true;
    } else if (db.users[userId].limit === undefined) {
        db.users[userId].limit = DEFAULT_LIMIT;
        migrated = true;
    }

    return { db, migrated };
}

// --- SYSTEM PROMPT (SST Specialist) ---
const SYSTEM_PROMPT = `از این به بعد نقش یک ارزیاب و ویرایشگر متخصص آزمون PTE Academic در بخش Summarize Spoken Text (SST) را داری. وظیفه تو تحلیل، نمره‌دهی و تصحیح متون خلاصه‌نویسی‌شده کاربران است.

مهم‌ترین معیارهای ارزیابی:
1. Form: متن باید دقیقاً بین 50 تا 70 کلمه باشد (کمتراز 50 یا بیشتر از 70 کلمه جریمه نمره Form دارد).
2. Grammar: سلامت دستوری، Subject-Verb Agreement، استفاده درست از حروف اضافه و ساختارهای مرکب/پیچیده.
3. Vocabulary: استفاده از واژگان آکادمیک و متناسب با موضوع.
4. Spelling: املای درست کلمات و رعایت یکپارچگی رسم‌الخط (UK یا US - نباید با هم ترکیب شوند).
5. Content: پوشش نکات و کلمات کلیدی اصلی.

سیاست برخورد با تمپلت:
سخت‌گیری بی‌مورد نکن. اگر متن کاربر دقیقاً از تمپلت پیروی نکرد اما از نظر گرامر، معنی، تعداد کلمات و انسجام درست بود، ایراد نگیر. 

تمپلت استاندارد مرجع (جهت پیشنهاد یا اصلاح):
The lecture provided a comprehensive overview of [Topic], focusing on [Main Idea]. First, [Key Point 1] was discussed. In addition, the role of [Key Point 2] was highlighted. Furthermore, several aspects of [Key Point 3] were clarified. Finally, it was emphasized that [Key Point 4] is fundamental to the topic.

دستورالعمل تحلیل محتوا:
- اگر متن اصلی لکچر (Transcript) ارسال شد: کلمات کلیدی، اسامی و مفاهیم اصلی خلاصه کاربر را با متن اصلی تطبیق بده و نمره Content را بر این اساس تعیین کن.
- اگر متن اصلی ارسال نشد: نمره Content را «تخمینی» اعلام کن و کلمات کلیدی احتمالی را بر اساس خلاصه کاربر تحلیل کن.

فرمت خروجی پاسخ (دقیقاً به همین ترتیب و بدون جدول ارسال کن):

📊 **کارنامه نمره‌دهی (از ۱۰ نمره):**
• Content: [نمره از 2]
• Form: [نمره از 2]
• Grammar: [نمره از 2]
• Vocabulary: [نمره از 2]
• Spelling: [نمره از 2]
• **نمره کل: [مجموع از 10]**

❌ **اشکالات اصلی:**
(توضیح کوتاه و موردبه‌مورد خطاهای گرامری، املایی یا ساختاری)

🔑 **تحلیل کلمات کلیدی و محتوا:**
(بررسی کلمات کلیدی و مفاهیم منتقل‌شده)

✍️ **نسخه اصلاح‌شده متن کاربر:**
[متن اصلاح‌شده]
• **Word Count:** [X]

💡 **نسخه پیشنهادی منطبق بر تمپلت استاندارد:**
[متن بر اساس تمپلت]
• **Word Count:** [X]`;

// --- Safe Multi-part Reply & UTF-8 Cleaning ---
async function safeReply(ctx, text) {
    const cleanText = text.replace(/[^\x09\x0A\x0D\x20-\x7E\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u2000-\u206F\u2070-\u218F\u2190-\u21FF\u2200-\u22FF\u2300-\u23FF\u2400-\u243F\u2500-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2900-\u297F\u2980-\u29FF\u2A00-\u2AFF\u2B00-\u2BFF\u2C00-\u2C5F\u2C60-\u2C7F\u2D00-\u2D7F\u2D80-\u2DDF\u2E00-\u2E7F\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/g, "");

    const chunks = cleanText.match(/.{1,3000}/gs) || [cleanText];
    for (const chunk of chunks) {
        try {
            await ctx.reply(chunk.trim(), { parse_mode: 'Markdown' });
        } catch (e) {
            await ctx.reply(chunk.trim());
        }
    }
}

// --- Commands ---
bot.start((ctx) => ctx.reply('خوش آمدید! متن خلاصه‌نویسی (SST) خود را بفرستید.'));

bot.command('add_user', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("❌ فقط ادمین‌ها دسترسی دارند.");
    const target = ctx.message.text.split(' ')[1];
    if (!target) return ctx.reply("فرمت: /add_user [ID]");

    try {
        const db = await getDB();
        if (!db.allowedUserIds.includes(target)) {
            db.allowedUserIds.push(target);
            await saveDB(db);
            ctx.reply(`✅ کاربر ${target} به لیست مجاز اضافه شد.`);
        } else {
            ctx.reply(`⚠️ کاربر ${target} قبلاً در لیست مجاز است.`);
        }
    } catch (e) { ctx.reply("⚠️ خطا در ذخیره اطلاعات."); }
});

bot.command('remove_user', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("❌ فقط ادمین‌ها دسترسی دارند.");
    const target = ctx.message.text.split(' ')[1];
    if (!target) return ctx.reply("فرمت: /remove_user [ID]");

    try {
        const db = await getDB();
        const index = db.allowedUserIds.indexOf(target);
        if (index > -1) {
            db.allowedUserIds.splice(index, 1);
            await saveDB(db);
            ctx.reply(`✅ کاربر ${target} از لیست مجاز حذف شد.`);
        } else {
            ctx.reply(`⚠️ کاربر ${target} در لیست مجاز نیست.`);
        }
    } catch (e) { ctx.reply("⚠️ خطا در ذخیره اطلاعات."); }
});

bot.command('credit_status', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("❌ فقط ادمین‌ها دسترسی دارند.");
    const target = ctx.message.text.split(' ')[1];
    if (!target) return ctx.reply("فرمت: /credit_status [ID]");

    try {
        const db = await getDB();
        const user = db.users?.[target];
        const used = user?.count ?? 0;
        const limit = user?.limit ?? DEFAULT_LIMIT;

        ctx.reply(
            `📊 وضعیت کاربر ${target}:\n\n` +
            `• وضعیت: ${user ? "✅ فعال" : "⏳ هنوز پیام نفرستاده"}\n` +
            `• استفاده شده: ${used}\n` +
            `• سقف: ${limit}\n` +
            `• باقی‌مانده: ${limit - used}`
        );
    } catch (e) { ctx.reply("⚠️ خطا در دریافت اطلاعات."); }
});

bot.command('credit_add', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("❌ فقط ادمین‌ها دسترسی دارند.");
    const parts = ctx.message.text.split(' ');
    const target = parts[1];
    const n = parseInt(parts[2]);
    if (!target || isNaN(n)) return ctx.reply("فرمت: /credit_add [ID] [تعداد]");

    try {
        let db = await getDB();
        const result = ensureUser(db, target);
        db = result.db;
        db.users[target].limit = (db.users[target].limit ?? DEFAULT_LIMIT) + n;

        if (await saveDB(db)) {
            ctx.reply(`✅ ${n} اعتبار به کاربر ${target} اضافه شد.\nسقف جدید: ${db.users[target].limit}`);
        } else ctx.reply("⚠️ خطا در ذخیره اطلاعات.");
    } catch (e) { ctx.reply("⚠️ خطا در ذخیره اطلاعات."); }
});

bot.command('credit_reset', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("❌ فقط ادمین‌ها دسترسی دارند.");
    const target = ctx.message.text.split(' ')[1];
    if (!target) return ctx.reply("فرمت: /credit_reset [ID]");

    try {
        const db = await getDB();
        if (!db.users?.[target]) return ctx.reply(`❌ کاربر ${target} یافت نشد.`);
        db.users[target] = { count: 0, limit: DEFAULT_LIMIT };

        if (await saveDB(db)) ctx.reply(`✅ اعتبار کاربر ${target} ریست شد.`);
        else ctx.reply("⚠️ خطا در ذخیره اطلاعات.");
    } catch (e) { ctx.reply("⚠️ خطا در ذخیره اطلاعات."); }
});

// --- Text Handler (SST Processing via Gemini) ---
bot.on('text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;

    const userId = String(ctx.from.id);
    const text = ctx.message.text;

    if (text.trim().split(/\s+/).length < 10) {
        return ctx.reply("لطفاً متن کامل خلاصه SST را وارد کنید.");
    }

    try {
        let db = await getDB();

        const hasAccess = isAdmin(userId) || db.allowedUserIds.includes(userId);
        if (!hasAccess) {
            return ctx.reply("❌ دسترسی غیرمجاز. لطفاً با ادمین تماس بگیرید.");
        }

        const result = ensureUser(db, userId);
        db = result.db;

        if (result.migrated) await saveDB(db);

        const userLimit = db.users[userId].limit ?? DEFAULT_LIMIT;
        const userCount = db.users[userId].count ?? 0;

        if (!isAdmin(userId) && userCount >= userLimit) {
            return ctx.reply(
                `❌ سهمیه شما تمام شده است.\n\n` +
                `استفاده شده: ${userCount}/${userLimit}\n` +
                `برای افزایش سهمیه با ادمین تماس بگیرید.`
            );
        }

        await ctx.sendChatAction('typing');
        await ctx.reply("⏳ در حال تحلیل و تصحیح متن SST شما طبق معیارهای PTE...");

        // فراخوانی مدل Gemini (اصلاح شده)
        const response = await ai.models.generateContent({
            model: 'gemini-1.5-flash',
            contents: text,
            config: {
                systemInstruction: SYSTEM_PROMPT,
            }
        });

        if (!isAdmin(userId)) {
            db = await getDB();
            db.users[userId].count = (db.users[userId].count ?? userCount) + 1;
            await saveDB(db);
        }

        await safeReply(ctx, response.text);

    } catch (e) {
        console.error('❌ Error in text handler:', e);
        ctx.reply("⚠️ خطایی در ارتباط با هوش مصنوعی یا سرور رخ داد. لطفاً دوباره تلاش کنید.");
    }
});

// --- Vercel Serverless Endpoint ---
app.post(`/api/bot`, (req, res) => bot.handleUpdate(req.body, res));
app.get('/', (req, res) => res.send('SST Correction Bot is running...'));

module.exports = app;
