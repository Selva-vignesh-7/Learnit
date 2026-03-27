import styles from "./LandingPage.module.css";
import { FaGithub } from "react-icons/fa6";
import { FaLinkedin } from "react-icons/fa";
import { FaGlobe } from "react-icons/fa";
import { Link } from "react-router-dom";

import heroImage from "../../assets/hero-image.png";
import personalizedLearningImage from "../../assets/personalized-learning.jpg";
import courseStructureImage from "../../assets/ai-course-structure.jpg";
import progressTrackingImage from "../../assets/progress-tracking.jpg";
import resourceLibraryImage from "../../assets/resource-library.jpg";

function LandingPage() {
  return (
    <>
      <Hero />
      <Features />
      <Team />
      <GetStarted />
    </>
  );
}

export default LandingPage;

function Hero() {
  return (
    <section className={styles.hero}>
      <div className={styles.heroText}>
        <h1>
          Learn Better.
          <br /> Plan Smarter.
        </h1>
        <p>
          Build courses and modules, auto-schedule study sessions, track your
          weekly progress, and stay consistent — all in one place.
        </p>
        <div className={styles.buttons}>
          <Link to="/auth/register" className={styles.getStartedButton}>
            Get Started
          </Link>
          <a href="#features" className={styles.learnMoreButton}>
            Learn More
          </a>
        </div>
      </div>
      <div className={styles.heroImage}>
        <img src={heroImage} alt="Hero Illustration" />
      </div>
    </section>
  );
}

function Features() {
  return (
    <section id="features" className={styles.features}>
      <h2>Product Features</h2>
      <p>
        Courses, scheduling, progress, and quizzes — designed to keep your
        learning consistent and measurable.
      </p>
      <div className={styles.featureList}>
        <div className={styles.featureItem}>
          <img src={personalizedLearningImage} alt="Personalized Plans" />
          <h3>Auto Scheduling</h3>
          <p>
            Turn modules into study sessions and auto-schedule them into your
            week based on your time and preferences.
          </p>
        </div>
        <div className={styles.featureItem}>
          <img src={courseStructureImage} alt="AI-Generated Course Structure" />
          <h3>Course Modules</h3>
          <p>
            Break courses into modules and sub-modules so your learning plan is
            structured and easy to finish.
          </p>
        </div>
        <div className={styles.featureItem}>
          <img src={progressTrackingImage} alt="Calendar Planning" />
          <h3>Calendar Views</h3>
          <p>
            Plan your week visually with a full calendar and quickly adjust
            sessions as your schedule changes.
          </p>
        </div>
        <div className={styles.featureItem}>
          <img src={progressTrackingImage} alt="Progress Tracking" />
          <h3>Progress Dashboard</h3>
          <p>
            Visualize scheduled vs completed hours, trends, and consistency so
            you can adjust and stay on track.
          </p>
        </div>
        <div className={styles.featureItem}>
          <img src={personalizedLearningImage} alt="Quizzes" />
          <h3>Quizzes</h3>
          <p>
            Test your understanding with built-in quizzes and track results as
            part of your learning progress.
          </p>
        </div>
        <div className={styles.featureItem}>
          <img src={resourceLibraryImage} alt="Resource Library" />
          <h3>Resources</h3>
          <p>
            Attach links to courses and keep everything you need in one place
            while you work through modules.
          </p>
        </div>
        <div className={styles.featureItem}>
          <img src={courseStructureImage} alt="Classrooms" />
          <h3>Classrooms</h3>
          <p>
            Share and reuse courses in classrooms so groups can follow the same
            structure and stay aligned.
          </p>
        </div>
      </div>
    </section>
  );
}

function Team() {
  return (
    <section id="about-us" className={styles.team}>
      <h2>Meet the Team</h2>
      <p>The developers behind the AI-Powered Personalized Study Planner.</p>
      <div className={styles.teamList}>
        <div className={styles.teamItem}>
          <img src={heroImage} alt="Sri Ram S" />
          <h3>Sri Ram S</h3>
          <h4>Full Stack Developer</h4>
          <Socials github="#" linkedin="#" website="#" />
        </div>
        <div className={styles.teamItem}>
          <img src={heroImage} alt="Naveen Kumar B" />
          <h3>Naveen Kumar B</h3>
          <h4>Full Stack Developer</h4>
          <Socials github="#" linkedin="#" website="#" />
        </div>
        <div className={styles.teamItem}>
          <img src={heroImage} alt="Raghavan S" />
          <h3>Raghavan S</h3>
          <h4>Full Stack Developer</h4>
          <Socials github="#" linkedin="#" website="#" />
        </div>
        <div className={styles.teamItem}>
          <img src={heroImage} alt="Selvavignesh G R" />
          <h3>Selvavignesh G R</h3>
          <h4>Full Stack Developer</h4>
          <Socials
            github="https://github.com/Selva-vignesh-7"
            linkedin="https://www.linkedin.com/in/selvavignesh/"
            website="https://github.com/Selva-vignesh-7/learnit.client"
          />
        </div>
      </div>
    </section>
  );
}

function Socials({ github, linkedin, website }) {
  return (
    <div className={styles.socials}>
      <a href={github} target="_blank" rel="noopener noreferrer">
        <FaGithub />
      </a>
      <a href={linkedin} target="_blank" rel="noopener noreferrer">
        <FaLinkedin />
      </a>
      <a href={website} target="_blank" rel="noopener noreferrer">
        <FaGlobe />
      </a>
    </div>
  );
}

function GetStarted() {
  return (
    <section id="contact" className={styles.getStarted}>
      <h2>Start Your Personalized Learning Journey!</h2>
      <p>
        Turn your goals into a structured, achievable weekly plan — powered by
        AI, tailored entirely for you.
      </p>
      <Link to="/auth/register" className={styles.getStartedButton}>
        Get Started
      </Link>
    </section>
  );
}
