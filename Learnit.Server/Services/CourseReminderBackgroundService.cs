using Learnit.Server.Data;
using Learnit.Server.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using System.Net;
using System.Net.Mail;

namespace Learnit.Server.Services
{
    public interface IEmailSender
    {
        Task SendAsync(string toEmail, string subject, string body, CancellationToken cancellationToken = default);
    }

    public class SmtpEmailSender : IEmailSender
    {
        private readonly EmailSettings _settings;

        public SmtpEmailSender(IOptions<EmailSettings> options)
        {
            _settings = options.Value;
        }

        public async Task SendAsync(string toEmail, string subject, string body, CancellationToken cancellationToken = default)
        {
            if (string.IsNullOrWhiteSpace(_settings.SmtpHost) ||
                string.IsNullOrWhiteSpace(_settings.FromEmail))
            {
                throw new InvalidOperationException("Email SMTP settings are not configured.");
            }

            using var message = new MailMessage
            {
                From = new MailAddress(_settings.FromEmail, _settings.FromName),
                Subject = subject,
                Body = body
            };
            message.To.Add(new MailAddress(toEmail));

            using var client = new SmtpClient(_settings.SmtpHost, _settings.SmtpPort)
            {
                EnableSsl = _settings.EnableSsl,
                Credentials = string.IsNullOrWhiteSpace(_settings.SmtpUser)
                    ? CredentialCache.DefaultNetworkCredentials
                    : new NetworkCredential(_settings.SmtpUser, _settings.SmtpPassword)
            };

            cancellationToken.ThrowIfCancellationRequested();
            await client.SendMailAsync(message, cancellationToken);
        }
    }

    public class CourseReminderBackgroundService : BackgroundService
    {
        private static readonly TimeSpan CheckInterval = TimeSpan.FromMinutes(15);
        private static readonly TimeSpan ReminderInterval = TimeSpan.FromHours(24);

        private readonly IServiceScopeFactory _scopeFactory;
        private readonly ILogger<CourseReminderBackgroundService> _logger;

        public CourseReminderBackgroundService(
            IServiceScopeFactory scopeFactory,
            ILogger<CourseReminderBackgroundService> logger)
        {
            _scopeFactory = scopeFactory;
            _logger = logger;
        }

        protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        {
            _logger.LogInformation("Course reminder background service started.");

            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await CheckAndSendReminders(stoppingToken);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed while processing course reminders.");
                }

                await Task.Delay(CheckInterval, stoppingToken);
            }
        }

        private async Task CheckAndSendReminders(CancellationToken cancellationToken)
        {
            using var scope = _scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var emailSender = scope.ServiceProvider.GetRequiredService<IEmailSender>();

            var now = DateTime.UtcNow;
            var candidates = await db.Courses
                .Where(c => c.IsActive && c.HoursRemaining > 0 && c.ReminderEmail != "")
                .ToListAsync(cancellationToken);

            foreach (var course in candidates)
            {
                var inactivityAnchor = course.LastStudiedAt ?? course.CreatedAt;
                var inactiveFor = now - inactivityAnchor;
                if (inactiveFor < ReminderInterval)
                {
                    continue;
                }

                // Send at most once per 24h and restart cadence after user studies again.
                if (course.LastReminderSentAt.HasValue)
                {
                    if (course.LastReminderSentAt.Value >= inactivityAnchor &&
                        now - course.LastReminderSentAt.Value < ReminderInterval)
                    {
                        continue;
                    }
                }

                try
                {
                    var subject = $"Reminder: Continue your course '{course.Title}'";
                    var body =
                        $"Hi,\n\n" +
                        $"You have not studied '{course.Title}' in the last 24 hours.\n" +
                        $"Open Learnit and continue your progress.\n\n" +
                        $"- Learnit";

                    await emailSender.SendAsync(course.ReminderEmail, subject, body, cancellationToken);
                    course.LastReminderSentAt = now;
                    course.UpdatedAt = now;
                    _logger.LogInformation("Reminder email sent for course {CourseId}.", course.Id);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to send reminder email for course {CourseId}.", course.Id);
                }
            }

            await db.SaveChangesAsync(cancellationToken);
        }
    }
}
