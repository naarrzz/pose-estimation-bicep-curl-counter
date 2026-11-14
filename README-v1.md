Flex and Count: Pose Estimation for Tracking Bicep Curl Reps

Project Aim:
This project implements a computer vision-based system to track bicep curl repetitions in real time using pose estimation. The system leverages Mediapipe for body landmark detection, OpenCV for video processing, and Tkinter for GUI development, aiming to deliver an accessible, cost-effective solution for personal fitness and rehabilitation.

How to Run the Code:

1. Dependencies:

> Python 3.x 
> Jupyter Notebook
> Standard Webcam
> Required Libraries:

	pip install mediapipe opencv-python numpy matplotlib

2. Steps:

> Open the Jupyter Notebook file pose_estimation_bicep_curl.ipynb in JupyterLab or Jupyter Notebook.
> Run the cells in sequence to:
	Initialize Mediapipe for pose detection.
	Process live webcam video to detect body landmarks.
	Calculate joint angles to track movement stages.
	Display real-time repetition tracking through a GUI.

3. Output:

> The system will:
	Count and display bicep curl repetitions in real time.
	Provide visual feedback on movement stages.
	Allow users to set repetition goals and monitor progress using a Tkinter GUI.

Dependencies:
> Mediapipe: For pose estimation.
> OpenCV: For video frame processing.
> NumPy: For mathematical operations.
> Matplotlib: For angle visualization (optional).
> Tkinter: For building the GUI.

Key Features:
Real-time Tracking: Detects body landmarks and calculates joint angles in real time.
Custom GUI: Intuitive interface for setting goals and monitoring progress.
Accessible Setup: Requires only a standard webcam and minimal hardware.