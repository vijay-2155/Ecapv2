const fastify = require("fastify")({
  logger: process.env.NODE_ENV === "production",
  trustProxy: true,
  keepAliveTimeout: 5000,
  connectionTimeout: 5000,
});

const Redis = require("ioredis");
const { Telegraf, Markup } = require("telegraf");
const axios = require("axios"); // Added axios for HTTP requests

// Configuration with validation
const config = {
  BOT_TOKEN:
    process.env.BOT_TOKEN || "7709646266:AAGZU0JKnX_8sk068Hk2dHYLJe8-dPfrLQw",
  REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
  PORT: parseInt(process.env.PORT) || 5000,
  NODE_ENV: process.env.NODE_ENV || "development",
  ATTENDANCE_API_URL: process.env.ATTENDANCE_API_URL || "http://localhost:8080/attendance", // Added API URL
};

// Initialize Redis with optimized settings
const redis = new Redis(config.REDIS_URL, {
  connectTimeout: 5000,
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  enableReadyCheck: false,
  maxLoadingTimeout: 5000,
});

// Initialize Telegram Bot with optimizations
const bot = new Telegraf(config.BOT_TOKEN, {
  telegram: {
    webhookReply: false,
    apiRoot: "https://api.telegram.org",
  },
});

// User states with TTL cleanup
const userStates = new Map();
const STATE_TTL = 300000; // 5 minutes

// State constants
const STATES = {
  IDLE: "idle",
  WAITING_USERNAME: "waiting_username",
  WAITING_PASSWORD: "waiting_password",
  WAITING_QUICK_CHECK_USERNAME: "waiting_quick_check_username",
  WAITING_QUICK_CHECK_PASSWORD: "waiting_quick_check_password",
};

// Cleanup expired states periodically
setInterval(() => {
  const now = Date.now();
  for (const [userId, state] of userStates.entries()) {
    if (now - state.timestamp > STATE_TTL) {
      userStates.delete(userId);
    }
  }
}, 60000); // Check every minute

// Utility functions
function escapeMarkdown(text) {
  return text.replace(/[_*\[\]()~`>#+=|{}.!-]/g, "\\$&");
}

function setUserState(userId, state, data = null) {
  userStates.set(userId, {
    state,
    data,
    timestamp: Date.now(),
  });
}

// HTTP API function to get attendance report
async function getAttendanceReport(username, password) {
  try {
    console.log(`Making API request to ${config.ATTENDANCE_API_URL} for user: ${username}`);
    
    const response = await axios.post(config.ATTENDANCE_API_URL, {
      username,
      password
    }, {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 30000, // 30 second timeout
    });

    console.log("API Response received:", response.status);
    return response.data;
  } catch (error) {
    console.error("Error fetching attendance from API:", error);
    
    if (error.response) {
      // Server responded with error status
      console.error("API Error Response:", error.response.status, error.response.data);
      throw new Error(`API Error: ${error.response.status} - ${error.response.data?.error || 'Unknown error'}`);
    } else if (error.request) {
      // Request was made but no response
      console.error("No response from API:", error.request);
      throw new Error("No response from attendance service. Please try again later.");
    } else {
      // Something else happened
      console.error("Request setup error:", error.message);
      throw new Error("Failed to connect to attendance service.");
    }
  }
}

// Replace the old formatAttendanceReport with the HTML version
function formatAttendanceReport(data) {
    if (data.error) {
        return `❌ <b>Error</b>\n\n${data.error}`;
    }

    const statusIcon = data.overall_percentage >= 75 ? "✅" : "❌";
    const statusText = data.overall_percentage >= 75 ? "Excellent! 🎯" : "Needs Attention ❗";
    const isAboveThreshold = data.overall_percentage >= 75;

    const lines = [
        "🏫 <b>Vignan's eCAP Bot</b>",
        "━━━━━━━━━━━━━━━━━━━━━━━",
        `👤 <b>Student ID:</b> <code>${data.student_id}</code>`,
        "",
        "📊 <b>Attendance Summary:</b>",
    ];

    // If no classes at all, show a friendly message
    if (data.total_classes === 0) {
        lines.push(
            "",
            "<b>No attendance data available yet.</b>",
            "<i>Class work has not started for any subject.</i>"
        );
    } else {
        lines.push(
            "",
            `• 🧮 <b>Overall (present/total):</b> ${data.total_present}/${data.total_classes}`,
            "",
            `• 📈 <b>Percentage:</b> ${data.overall_percentage.toFixed(2)}% ${statusIcon}`,
            "",
            `📌 <b>Status:</b> ${statusText}`
        );

        // Defensive: default to 0 if undefined
        const skippable = typeof data.skippable_hours === 'number' ? data.skippable_hours : 0;
        const required = typeof data.required_hours === 'number' ? data.required_hours : 0;

        if (isAboveThreshold && skippable > 0) {
            lines.push(`🛑 <b>Skippable:</b> You can miss <u><b>${skippable}</b></u> classes.`);
        } else if (!isAboveThreshold && required > 0) {
            lines.push(`📚 <b>Required:</b> Attend <b>${required}</b> more classes to reach 75%.`);
        }
    }

    // Today's Attendance
    if (data.todays_attendance && data.todays_attendance.length > 0) {
        lines.push("", "📅 <b>Today's Attendance:</b>", "━━━━━━━━━━━━━━━━━━━━━━━");
        // Group by subject
        const subjectMap = {};
        data.todays_attendance.forEach(entry => {
            const [subject, status] = entry.split(":").map(str => str.trim());
            if (!subjectMap[subject]) subjectMap[subject] = [];
            subjectMap[subject].push(status);
        });
        Object.entries(subjectMap).forEach(([subject, statuses]) => {
            const allStatuses = statuses.flatMap(s => s.split(""));
            lines.push(`• <b>${subject}:</b> <b>${allStatuses.join(" ")}</b>`);
        });
    } else {
        lines.push("", "📅 <b>Today's Attendance:</b>", "━━━━━━━━━━━━━━━━━━━━━━━");
        lines.push("<i>No attendance posted for today or not available.</i>");
    }

    // Subject-wise Breakdown (show all subjects, styled)
    if (data.subject_attendance?.length) {
        lines.push("", "📚 <b>Subject-wise Breakdown:</b>", "━━━━━━━━━━━━━━━━━━━━━━━");
        data.subject_attendance.forEach(entry => {
            const parts = entry.split(/\s+/);
            const percentage = parts[parts.length - 1];
            const fraction = parts[parts.length - 2];
            const subject = parts.slice(0, -2).join(" ").replace(/\.+/g, "");
            // Extract present and total from fraction (e.g., "0/0")
            const [present, total] = fraction.split('/').map(Number);

            if (total === 0) {
                lines.push(`<b>${subject}</b>: <i>Class work not started yet</i>`);
            } else {
                lines.push(`<b>${subject}</b>: <b>${fraction}</b> → <b>${percentage}</b>`);
            }
        });
    }
    lines.push("","━━━━━━━━━━━━━━━━━━━━━━━");
    const now = new Date();
    const istString = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    lines.push("Last Updated: " + istString + " (IST)");
    lines.push("🤖 <i>Smart Attendance Bot</i>");

    return lines.join("\n");
}

// Redis helper functions with error handling
async function saveUser(userId, username, password) {
  try {
    const key = `user:${userId}`;
    await redis.hset(key, {
      username,
      password, // Note: In production, encrypt this
      created_at: new Date().toISOString(),
      last_used: new Date().toISOString(),
    });
    await redis.expire(key, 86400 * 30); // 30 days TTL
  } catch (error) {
    console.error("Error saving user:", error);
    throw error;
  }
}

async function getUser(userId) {
  try {
    const key = `user:${userId}`;
    const user = await redis.hgetall(key);
    return Object.keys(user).length ? user : null;
  } catch (error) {
    console.error("Error getting user:", error);
    return null;
  }
}

async function updateLastUsed(userId) {
  try {
    const key = `user:${userId}`;
    await redis.hset(key, "last_used", new Date().toISOString());
  } catch (error) {
    console.error("Error updating last used:", error);
  }
}

async function deleteUser(userId) {
  try {
    const key = `user:${userId}`;
    await redis.del(key);
  } catch (error) {
    console.error("Error deleting user:", error);
    throw error;
  }
}

// Enhanced attendance check with better error handling
async function checkAttendance(ctx, username, password, messageId = null) {
  try {
    const report = await getAttendanceReport(username, password);
    const formattedReport = formatAttendanceReport(report);
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("🔄 Refresh", "check_saved")],
      [Markup.button.callback("🏠 Back to Menu", "back_to_menu")],
    ]);

    if (messageId) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        messageId,
        undefined,
        formattedReport,
        {
          parse_mode: "HTML",
          reply_markup: keyboard.reply_markup,
        }
      );
    } else {
      await ctx.reply(formattedReport, {
        parse_mode: "HTML",
        reply_markup: keyboard.reply_markup,
      });
    }
    return report;
  } catch (error) {
    console.error("Error checking attendance:", error);
    const errorMessage =
      "❌ *Error occurred while checking attendance*\n\nPlease verify your credentials and try again\\.";
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("🔄 Try Again", "check_saved")],
      [Markup.button.callback("🏠 Back to Menu", "back_to_menu")],
    ]);

    try {
      if (messageId) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          messageId,
          undefined,
          errorMessage,
          {
            parse_mode: "MarkdownV2",
            reply_markup: keyboard.reply_markup,
          }
        );
      } else {
        await ctx.reply(errorMessage, {
          parse_mode: "MarkdownV2",
          reply_markup: keyboard.reply_markup,
        });
      }
    } catch (editError) {
      console.error("Error editing message:", editError);
      await ctx.reply(errorMessage, {
        parse_mode: "MarkdownV2",
        reply_markup: keyboard.reply_markup,
      });
    }
    throw error;
  }
}

// Common keyboard layouts
const getMainKeyboard = (hasUser) => {
  return hasUser
    ? Markup.inlineKeyboard([
        [Markup.button.callback("📊 Check My Attendance", "check_saved")],
        [Markup.button.callback("🔍 Quick Check", "quick_check")],
        [
          Markup.button.callback("⚙️ Update Credentials", "update_creds"),
          Markup.button.callback("🗑️ Remove Account", "remove_account"),
        ],
      ])
    : Markup.inlineKeyboard([
        [Markup.button.callback("💾 Save Credentials", "save_creds")],
        [Markup.button.callback("🔍 Quick Check", "quick_check")],
      ]);
};

// Bot handlers with improved flow
bot.start(async (ctx) => {
  try {
    const user = await getUser(ctx.from.id);
    const welcomeMessage = `🏫 <b>Welcome to Vignan's eCAP Bot!</b>\n
I'm here to help you track your class attendance with ease and clarity 📊.\n
${user
      ? "✅ <b>Your credentials are already saved!</b> You can check your latest attendance report right away. 👇"
      : "📝 <b>Let's get started!</b> Please save your credentials to begin tracking your attendance. 👇"
    }`;

    await ctx.reply(welcomeMessage, {
      parse_mode: "HTML",
      reply_markup: getMainKeyboard(!!user).reply_markup,
    });
  } catch (error) {
    console.error("Error in start handler:", error);
    await ctx.reply(
      "❌ <b>Service temporarily unavailable. Please try again later.</b>",
      {
        parse_mode: "HTML",
      }
    );
  }
});

// Optimized callback handlers
bot.action("check_saved", async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from.id);

    if (!user) {
      await ctx.editMessageText(
        "❌ *No saved credentials found\\!*\n\nPlease save your credentials first\\.",
        {
          parse_mode: "MarkdownV2",
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback("💾 Save Credentials", "save_creds")],
            [Markup.button.callback("🏠 Back to Menu", "back_to_menu")],
          ]).reply_markup,
        }
      );
      return;
    }

    const statusMessage = await ctx.editMessageText(
      "🔄 *Checking your attendance\\.\\.\\.*",
      { parse_mode: "MarkdownV2" }
    );

    await checkAttendance(
      ctx,
      user.username,
      user.password,
      statusMessage.message_id
    );
    await updateLastUsed(ctx.from.id);
  } catch (error) {
    console.error("Error in check_saved:", error);
    await ctx.answerCbQuery("❌ Error occurred");
  }
});

bot.action("save_creds", async (ctx) => {
  try {
    await ctx.answerCbQuery();
    setUserState(ctx.from.id, STATES.WAITING_USERNAME);

    await ctx.editMessageText(
      "👤 *Please enter your username or student ID*:",
      {
        parse_mode: "MarkdownV2",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("❌ Cancel", "back_to_menu")],
        ]).reply_markup,
      }
    );
  } catch (error) {
    console.error("Error in save_creds:", error);
    await ctx.answerCbQuery("❌ Error occurred");
  }
});

bot.action("update_creds", async (ctx) => {
  try {
    await ctx.answerCbQuery();
    setUserState(ctx.from.id, STATES.WAITING_USERNAME);

    await ctx.editMessageText(
      "⚙️ *Update Credentials*\n\nPlease enter your new *username/student ID*:",
      {
        parse_mode: "MarkdownV2",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("❌ Cancel", "back_to_menu")],
        ]).reply_markup,
      }
    );
  } catch (error) {
    console.error("Error in update_creds:", error);
    await ctx.answerCbQuery("❌ Error occurred");
  }
});

bot.action("remove_account", async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      "🗑️ *Remove Account*\n\nAre you sure you want to remove your saved credentials?",
      {
        parse_mode: "MarkdownV2",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("✅ Yes, Remove", "confirm_remove")],
          [Markup.button.callback("❌ Cancel", "back_to_menu")],
        ]).reply_markup,
      }
    );
  } catch (error) {
    console.error("Error in remove_account:", error);
    await ctx.answerCbQuery("❌ Error occurred");
  }
});

bot.action("confirm_remove", async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await deleteUser(ctx.from.id);
    userStates.delete(ctx.from.id);

    await ctx.editMessageText(
      "✅ *Account Removed Successfully*\n\nYour credentials have been deleted\\.",
      {
        parse_mode: "MarkdownV2",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("🏠 Back to Menu", "back_to_menu")],
        ]).reply_markup,
      }
    );
  } catch (error) {
    console.error("Error in confirm_remove:", error);
    await ctx.answerCbQuery("❌ Error occurred");
  }
});

bot.action("quick_check", async (ctx) => {
  try {
    await ctx.answerCbQuery();
    setUserState(ctx.from.id, STATES.WAITING_QUICK_CHECK_USERNAME);

    await ctx.editMessageText(
      "🔍 *Quick Attendance Check*\n\nPlease enter your *username/student ID*:",
      {
        parse_mode: "MarkdownV2",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("❌ Cancel", "back_to_menu")],
        ]).reply_markup,
      }
    );
  } catch (error) {
    console.error("Error in quick_check:", error);
    await ctx.answerCbQuery("❌ Error occurred");
  }
});

bot.action("back_to_menu", async (ctx) => {
  try {
    await ctx.answerCbQuery();
    userStates.delete(ctx.from.id);

    const user = await getUser(ctx.from.id);
    const welcomeMessage = `🎓 *Vignan's eCAP Bot*\n\n${
      user
        ? "✅ *Credentials saved and ready to use*"
        : "📝 *Ready to help you check attendance*"
    }`;

    await ctx.editMessageText(welcomeMessage, {
      parse_mode: "MarkdownV2",
      reply_markup: getMainKeyboard(!!user).reply_markup,
    });
  } catch (error) {
    console.error("Error in back_to_menu:", error);
    await ctx.answerCbQuery("❌ Error occurred");
  }
});

// Enhanced text message handler
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const userState = userStates.get(userId);
  const text = ctx.message.text.trim();

  if (!userState || userState.state === STATES.IDLE) {
    await ctx.reply(
      "👋 Use /start to access the main menu and check your attendance!",
      {
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("🎓 Open Main Menu", "back_to_menu")],
        ]).reply_markup,
      }
    );
    return;
  }

  // Check if state is expired
  if (Date.now() - userState.timestamp > STATE_TTL) {
    userStates.delete(userId);
    await ctx.reply("⏰ *Session expired\\!* Please start over\\.", {
      parse_mode: "MarkdownV2",
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("🏠 Main Menu", "back_to_menu")],
      ]).reply_markup,
    });
    return;
  }

  try {
    switch (userState.state) {
      case STATES.WAITING_USERNAME:
        setUserState(userId, STATES.WAITING_PASSWORD, { username: text });
        await ctx.reply("🔐 *Now enter your password*:", {
          parse_mode: "MarkdownV2",
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback("❌ Cancel", "back_to_menu")],
          ]).reply_markup,
        });
        break;

      case STATES.WAITING_PASSWORD:
        await saveUser(userId, userState.data.username, text);
        userStates.delete(userId);
        await ctx.reply(
          "✅ *Credentials Saved Successfully\\!*\n\n⚠️ *Security Note*: Your credentials are stored securely\\.\n\nYou can now check your attendance easily\\!",
          {
            parse_mode: "MarkdownV2",
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  "📊 Check Attendance Now",
                  "check_saved"
                ),
              ],
              [Markup.button.callback("🏠 Main Menu", "back_to_menu")],
            ]).reply_markup,
          }
        );
        break;

      case STATES.WAITING_QUICK_CHECK_USERNAME:
        setUserState(userId, STATES.WAITING_QUICK_CHECK_PASSWORD, {
          username: text,
        });
        await ctx.reply("🔐 *Now enter your password*:", {
          parse_mode: "MarkdownV2",
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback("❌ Cancel", "back_to_menu")],
          ]).reply_markup,
        });
        break;

      case STATES.WAITING_QUICK_CHECK_PASSWORD:
        const username = userState.data.username;
        const password = text;
        userStates.delete(userId);

        const statusMessage = await ctx.reply(
          "🔄 *Checking attendance\\.\\.\\.*",
          { parse_mode: "MarkdownV2" }
        );

        try {
          await checkAttendance(
            ctx,
            username,
            password,
            statusMessage.message_id
          );
          // Add save credentials option after successful quick check
          await ctx.reply(
            "💡 *Tip*: Save your credentials for faster access next time\\!",
            {
              parse_mode: "MarkdownV2",
              reply_markup: Markup.inlineKeyboard([
                [
                  Markup.button.callback(
                    "💾 Save These Credentials",
                    "save_creds"
                  ),
                ],
                [Markup.button.callback("🏠 Main Menu", "back_to_menu")],
              ]).reply_markup,
            }
          );
        } catch (error) {
          // Error handling is managed in checkAttendance
        }
        break;

      default:
        await ctx.reply(
          "❌ *Unexpected input\\!* Please follow the prompts or start over\\.",
          {
            parse_mode: "MarkdownV2",
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback("🏠 Main Menu", "back_to_menu")],
            ]).reply_markup,
          }
        );
        userStates.delete(userId);
        break;
    }
  } catch (error) {
    console.error("Error handling text message:", error);
    userStates.delete(userId);
    await ctx.reply("❌ *Something went wrong\\!* Please try again\\.", {
      parse_mode: "MarkdownV2",
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("🏠 Main Menu", "back_to_menu")],
      ]).reply_markup,
    });
  }
});

// Enhanced error handling
bot.catch((err, ctx) => {
  console.error("Bot error:", err);
  if (ctx) {
    ctx.reply("❌ *An error occurred\\!* Please try again later\\.", {
      parse_mode: "MarkdownV2",
    });
  }
});

// Optimized Fastify routes
fastify.get("/", async () => {
  return {
    status: "online",
    bot: "Smart Attendance Bot",
    version: "2.0.0",
    timestamp: new Date().toISOString(),
  };
});

fastify.get("/health", async () => {
  try {
    const start = Date.now();
    await redis.ping();
    const redisLatency = Date.now() - start;

    return {
      status: "healthy",
      redis: "connected",
      redis_latency: `${redisLatency}ms`,
      memory: process.memoryUsage(),
      uptime: process.uptime(),
    };
  } catch (error) {
    return {
      status: "unhealthy",
      redis: "disconnected",
      error: error.message,
    };
  }
});

// Enhanced API endpoint with rate limiting
fastify.register(require("@fastify/rate-limit"), {
  max: 100,
  timeWindow: "1 minute",
});

fastify.post("/attendance", async (request, reply) => {
  const { username, password } = request.body;

  if (!username || !password) {
    reply.code(400);
    return { error: "Username and password are required" };
  }

  try {
    const report = await getAttendanceReport(username, password);
    return report;
  } catch (error) {
    console.error("API error:", error);
    reply.code(500);
    return { error: "Failed to fetch attendance report" };
  }
});

// Graceful shutdown with proper cleanup
const gracefulShutdown = async (signal) => {
  console.log(`Received ${signal}, shutting down gracefully...`);

  const shutdownTasks = [
    { name: "Bot", task: () => bot.stop(signal) },
    { name: "Redis", task: () => redis.quit() },
    { name: "Fastify", task: () => fastify.close() },
  ];

  for (const { name, task } of shutdownTasks) {
    try {
      await task();
      console.log(`✅ ${name} shut down successfully`);
    } catch (error) {
      console.error(`❌ Error shutting down ${name}:`, error);
    }
  }

  console.log("Shutdown completed");
  process.exit(0);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Optimized startup sequence
const start = async () => {
  console.log("🚀 Starting Smart Attendance Bot...");

  try {
    // Start Redis connection
    console.log("📡 Connecting to Redis...");
    await redis.connect();
    console.log("✅ Redis connected");

    // Start Fastify server
    console.log("🌐 Starting Fastify server...");
    await fastify.listen({
      port: config.PORT,
      host: "0.0.0.0",
      backlog: 511,
    });
    console.log(`✅ Fastify server started on port ${config.PORT}`);

    // Start Telegram bot
    console.log("🤖 Starting Telegram bot...");
    await bot.launch({
      polling: {
        timeout: 10,
        limit: 100,
        allowedUpdates: ["message", "callback_query"],
      },
    });
    console.log("✅ Telegram bot started");

    console.log("🎉 Smart Attendance Bot is fully operational!");
    console.log(`Environment: ${config.NODE_ENV}`);
    console.log(`Port: ${config.PORT}`);
    console.log(`Attendance API: ${config.ATTENDANCE_API_URL}`);
  } catch (error) {
    console.error("❌ Failed to start application:", error);
    process.exit(1);
  }
};

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});

start();
