using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Server.Migrations
{
    /// <inheritdoc />
    public partial class AddCourseReminderEmail : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "DifficultyScore",
                table: "CourseSubModules");

            migrationBuilder.DropColumn(
                name: "DifficultyScore",
                table: "CourseModules");

            migrationBuilder.AddColumn<DateTime>(
                name: "LastReminderSentAt",
                table: "Courses",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ReminderEmail",
                table: "Courses",
                type: "text",
                nullable: false,
                defaultValue: "");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "LastReminderSentAt",
                table: "Courses");

            migrationBuilder.DropColumn(
                name: "ReminderEmail",
                table: "Courses");

            migrationBuilder.AddColumn<int>(
                name: "DifficultyScore",
                table: "CourseSubModules",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "DifficultyScore",
                table: "CourseModules",
                type: "integer",
                nullable: false,
                defaultValue: 0);
        }
    }
}
