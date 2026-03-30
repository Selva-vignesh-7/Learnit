using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using System.Text;
using Learnit.Server.Data;
using Learnit.Server.Services;
using Learnit.Server.Models;
using Npgsql.EntityFrameworkCore.PostgreSQL;
using Microsoft.AspNetCore.Authentication.JwtBearer; 
using Microsoft.AspNetCore.HttpOverrides;

namespace Learnit.Server
{
    public class Program
    {
        public static void Main(string[] args)
        {
            // Check for test-ai command
            if (args.Length > 0 && args[0] == "test-ai")
            {
                var testBuilder = WebApplication.CreateBuilder(args);
                var config = testBuilder.Configuration;
                TestAiProvider.TestAsync(config).Wait();
                return;
            }

            var builder = WebApplication.CreateBuilder(args);

            if (builder.Environment.IsDevelopment())
            {
                // Ensure user-secrets are available for local development.
                builder.Configuration.AddUserSecrets<Program>(optional: true);
            }

            var connectionString = builder.Configuration.GetConnectionString("Default");
            if (string.IsNullOrWhiteSpace(connectionString))
            {
                throw new InvalidOperationException(
                    "Connection string 'ConnectionStrings:Default' is not configured. " +
                    "Set it via user-secrets in Development or environment variables/secret store in Production.");
            }

            var jwtKey = builder.Configuration["Jwt:Key"];
            if (string.IsNullOrWhiteSpace(jwtKey))
            {
                throw new InvalidOperationException(
                    "JWT signing key 'Jwt:Key' is not configured. " +
                    "Set it via user-secrets in Development or environment variables/secret store in Production.");
            }

            builder.Services.AddDbContext<AppDbContext>(opt =>
                opt.UseNpgsql(connectionString)
                   .ConfigureWarnings(w => w.Ignore(Microsoft.EntityFrameworkCore.Diagnostics.RelationalEventId.PendingModelChangesWarning)));

            builder.Services.Configure<ForwardedHeadersOptions>(options =>
            {
                options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
                options.KnownNetworks.Clear();
                options.KnownProxies.Clear();
            });

            builder.Services.AddCors(opt =>
            {
                opt.AddPolicy("AllowFrontend", policy =>
                {
                    var origins = builder.Configuration
                        .GetSection("Cors:AllowedOrigins")
                        .Get<string[]>()
                        ?? Array.Empty<string>();

                    if ((origins == null || origins.Length == 0) && builder.Environment.IsDevelopment())
                    {
                        origins = new[]
                        {
                            "http://localhost:5173",
                            "https://localhost:51338",
                            "http://localhost:51338"
                        };
                    }

                    if (origins == null || origins.Length == 0)
                    {
                        throw new InvalidOperationException(
                            "CORS is not configured. Set Cors:AllowedOrigins (e.g., via Cors__AllowedOrigins__0) to your deployed frontend origin.");
                    }

                    // JWT is sent via Authorization header (not cookies), so credentials are not required.
                    policy.WithOrigins(origins)
                        .AllowAnyHeader()
                        .AllowAnyMethod();
                });
            });


            builder.Services.AddControllers()
                .AddJsonOptions(options =>
                {
                    options.JsonSerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
                    options.JsonSerializerOptions.ReferenceHandler = System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles;
                    options.JsonSerializerOptions.MaxDepth = 32;
                });
            builder.Services.AddScoped<JwtService>();
            builder.Services.AddScoped<AiContextBuilder>();
            builder.Services.AddHttpClient<UrlMetadataService>();
            builder.Services.AddHttpClient<YouTubeDataApiService>();
            builder.Services.AddScoped<YouTubeCourseService>();
            builder.Services.AddScoped<FriendService>();
            builder.Services.AddScoped<AwardService>();
            builder.Services.AddHttpClient<IAiProvider, OpenAiProvider>();
            builder.Services.Configure<EmailSettings>(builder.Configuration.GetSection("Email"));
            builder.Services.AddScoped<IEmailSender, SmtpEmailSender>();
            builder.Services.AddScoped<ICourseScheduleGeneticService, CourseScheduleGeneticService>();
            builder.Services.AddHostedService<CourseReminderBackgroundService>();

            // JWT authentication
            builder.Services.AddAuthentication("Bearer")
                .AddJwtBearer("Bearer", opt =>
                {
                    opt.TokenValidationParameters = new()
                    {
                        ValidateIssuer = true,
                        ValidateAudience = true,
                        ValidateIssuerSigningKey = true,
                        ValidIssuer = builder.Configuration["Jwt:Issuer"],
                        ValidAudience = builder.Configuration["Jwt:Audience"],
                        IssuerSigningKey = new SymmetricSecurityKey(
                            System.Text.Encoding.UTF8.GetBytes(jwtKey))
                    };
                });

            var app = builder.Build();

            if (!app.Environment.IsDevelopment())
            {
                app.UseHsts();
            }

            app.UseForwardedHeaders();

            // Optional: run migrations on startup (useful for first deploys)
            using (var scope = app.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                var runMigrations = builder.Configuration.GetValue<bool>("Database:RunMigrations");

                if (runMigrations)
                {
                    db.Database.Migrate();
                }

                // Safe award seeding: only if DB is reachable
                if (db.Database.CanConnect())
                {
                    try
                    {
                        SeedAwards(db);
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine("Award seeding skipped: " + ex.Message);
                    }
                }
            }

            app.UseCors("AllowFrontend");
            app.UseAuthentication();
            app.UseAuthorization();

            app.MapGet("/health", () => Results.Ok(new { status = "ok" }))
                .AllowAnonymous();

            app.MapControllers();
            app.Run();
        }

        private static void SeedAwards(AppDbContext db)
        {
            if (db.Awards.Any())
            {
                return; // Awards already seeded
            }

            var awards = new List<Award>
            {
                // Hours Awards
                new Award { Code = "HOURS_1", Name = "First Hour", Description = "Complete 1 hour of study", Icon = "⏰", Category = "hours", Threshold = 1, Color = "#10b981", Order = 1 },
                new Award { Code = "HOURS_5", Name = "Dedicated Learner", Description = "Complete 5 hours of study", Icon = "📚", Category = "hours", Threshold = 5, Color = "#3b82f6", Order = 2 },
                new Award { Code = "HOURS_10", Name = "Scholar", Description = "Complete 10 hours of study", Icon = "🎓", Category = "hours", Threshold = 10, Color = "#8b5cf6", Order = 3 },
                new Award { Code = "HOURS_25", Name = "Expert", Description = "Complete 25 hours of study", Icon = "🏆", Category = "hours", Threshold = 25, Color = "#f59e0b", Order = 4 },
                new Award { Code = "HOURS_50", Name = "Master", Description = "Complete 50 hours of study", Icon = "👑", Category = "hours", Threshold = 50, Color = "#ef4444", Order = 5 },
                new Award { Code = "HOURS_100", Name = "Grand Master", Description = "Complete 100 hours of study", Icon = "💎", Category = "hours", Threshold = 100, Color = "#ec4899", Order = 6 },
                new Award { Code = "HOURS_250", Name = "Legend", Description = "Complete 250 hours of study", Icon = "🌟", Category = "hours", Threshold = 250, Color = "#6366f1", Order = 7 },
                new Award { Code = "HOURS_500", Name = "Mythic", Description = "Complete 500 hours of study", Icon = "✨", Category = "hours", Threshold = 500, Color = "#14b8a6", Order = 8 },

                // Course Completion Awards
                new Award { Code = "COURSES_1", Name = "First Course", Description = "Complete your first course", Icon = "🎯", Category = "courses", Threshold = 1, Color = "#10b981", Order = 1 },
                new Award { Code = "COURSES_3", Name = "Triple Threat", Description = "Complete 3 courses", Icon = "📖", Category = "courses", Threshold = 3, Color = "#3b82f6", Order = 2 },
                new Award { Code = "COURSES_5", Name = "Course Collector", Description = "Complete 5 courses", Icon = "📚", Category = "courses", Threshold = 5, Color = "#8b5cf6", Order = 3 },
                new Award { Code = "COURSES_10", Name = "Decade Master", Description = "Complete 10 courses", Icon = "🎓", Category = "courses", Threshold = 10, Color = "#f59e0b", Order = 4 },
                new Award { Code = "COURSES_20", Name = "Course Champion", Description = "Complete 20 courses", Icon = "🏆", Category = "courses", Threshold = 20, Color = "#ef4444", Order = 5 },
                new Award { Code = "COURSES_50", Name = "Course Legend", Description = "Complete 50 courses", Icon = "👑", Category = "courses", Threshold = 50, Color = "#ec4899", Order = 6 },

                // Consistency/Streak Awards
                new Award { Code = "STREAK_3", Name = "Three Day Streak", Description = "Maintain a 3-day study streak", Icon = "🔥", Category = "consistency", Threshold = 3, Color = "#f97316", Order = 1 },
                new Award { Code = "STREAK_7", Name = "Week Warrior", Description = "Maintain a 7-day study streak", Icon = "🔥🔥", Category = "consistency", Threshold = 7, Color = "#ea580c", Order = 2 },
                new Award { Code = "STREAK_14", Name = "Fortnight Fighter", Description = "Maintain a 14-day study streak", Icon = "🔥🔥🔥", Category = "consistency", Threshold = 14, Color = "#dc2626", Order = 3 },
                new Award { Code = "STREAK_30", Name = "Monthly Master", Description = "Maintain a 30-day study streak", Icon = "🔥🔥🔥🔥", Category = "consistency", Threshold = 30, Color = "#b91c1c", Order = 4 },
                new Award { Code = "STREAK_60", Name = "Two Month Titan", Description = "Maintain a 60-day study streak", Icon = "🔥🔥🔥🔥🔥", Category = "consistency", Threshold = 60, Color = "#991b1b", Order = 5 },
                new Award { Code = "STREAK_100", Name = "Century Streak", Description = "Maintain a 100-day study streak", Icon = "🔥🔥🔥🔥🔥🔥", Category = "consistency", Threshold = 100, Color = "#7f1d1d", Order = 6 },
                new Award { Code = "STREAK_365", Name = "Year Warrior", Description = "Maintain a 365-day study streak", Icon = "💯", Category = "consistency", Threshold = 365, Color = "#450a0a", Order = 7 },

                // Longest Streak Awards
                new Award { Code = "LONGEST_7", Name = "Best Week", Description = "Achieve a longest streak of 7 days", Icon = "⭐", Category = "longeststreak", Threshold = 7, Color = "#f59e0b", Order = 1 },
                new Award { Code = "LONGEST_30", Name = "Best Month", Description = "Achieve a longest streak of 30 days", Icon = "⭐⭐", Category = "longeststreak", Threshold = 30, Color = "#f97316", Order = 2 },
                new Award { Code = "LONGEST_100", Name = "Best Century", Description = "Achieve a longest streak of 100 days", Icon = "⭐⭐⭐", Category = "longeststreak", Threshold = 100, Color = "#dc2626", Order = 3 },
            };

            db.Awards.AddRange(awards);
            db.SaveChanges();
        }
    }
}
