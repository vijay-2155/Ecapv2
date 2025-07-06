// attendance/attendance.go
package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
)

type AttendanceResponse struct {
	StudentID         string   `json:"student_id"`
	TotalPresent      int      `json:"total_present"`
	TotalClasses      int      `json:"total_classes"`
	OverallPercentage float64  `json:"overall_percentage"`
	TodaysAttendance  []string `json:"todays_attendance"`
	SubjectAttendance []string `json:"subject_attendance"`
	SkippableHours    int      `json:"skippable_hours"`
	RequiredHours     int      `json:"required_hours"`
	Error             string   `json:"error,omitempty"`
}

func pkcs7Pad(data []byte, blockSize int) []byte {
	padLen := blockSize - len(data)%blockSize
	padding := bytes.Repeat([]byte{byte(padLen)}, padLen)
	return append(data, padding...)
}

func encryptPasswordAES(plainText string) (string, error) {
	key := []byte("8701661282118308")
	iv := []byte("8701661282118308")
	plaintextBytes := pkcs7Pad([]byte(plainText), aes.BlockSize)

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}

	cipherText := make([]byte, len(plaintextBytes))
	mode := cipher.NewCBCEncrypter(block, iv)
	mode.CryptBlocks(cipherText, plaintextBytes)

	return base64.StdEncoding.EncodeToString(cipherText), nil
}

func extractHiddenFields(body []byte) (string, string, error) {
	doc, err := goquery.NewDocumentFromReader(bytes.NewReader(body))
	if err != nil {
		return "", "", err
	}

	viewState, exists1 := doc.Find("input[name='__VIEWSTATE']").Attr("value")
	eventValidation, exists2 := doc.Find("input[name='__EVENTVALIDATION']").Attr("value")

	if !exists1 || !exists2 {
		return "", "", fmt.Errorf("missing viewstate or eventvalidation")
	}

	return viewState, eventValidation, nil
}

func calculateSkippableHours(present, total int) int {
	if total == 0 || float64(present)/float64(total)*100 < 75 {
		return 0
	}
	skippable := 0
	tempPresent := present
	tempTotal := total
	for {
		tempTotal++
		if float64(tempPresent)/float64(tempTotal)*100 >= 75 {
			skippable++
		} else {
			break
		}
	}
	return skippable
}

func calculateRequiredHours(present, total int) int {
	if total == 0 || float64(present)/float64(total)*100 >= 75 {
		return 0
	}
	required := 0
	tempPresent := present
	tempTotal := total
	for {
		tempPresent++
		tempTotal++
		required++
		if float64(tempPresent)/float64(tempTotal)*100 >= 75 {
			break
		}
	}
	return required
}

func getCurrentDate() string {
	now := time.Now()
	return fmt.Sprintf("%02d/%02d", now.Day(), int(now.Month()))
}

func FetchAttendanceAPI(username, password string) AttendanceResponse {
	client := &http.Client{Timeout: 30 * time.Second}
	jar, _ := cookiejar.New(nil)
	client.Jar = jar

	loginURL := "https://webprosindia.com/vignanit/Default.aspx"
	attendanceURL := "https://webprosindia.com/vignanit/Academics/studentacadamicregister.aspx?scrid=2"

	resp, err := client.Get(loginURL)
	if err != nil {
		return AttendanceResponse{Error: fmt.Sprintf("failed to get login page: %v", err)}
	}
	defer resp.Body.Close()
	bodyBytes, _ := io.ReadAll(resp.Body)

	viewState, eventValidation, err := extractHiddenFields(bodyBytes)
	if err != nil {
		return AttendanceResponse{Error: err.Error()}
	}

	encryptedPassword, err := encryptPasswordAES(password)
	if err != nil {
		return AttendanceResponse{Error: err.Error()}
	}

	data := url.Values{}
	data.Set("__VIEWSTATE", viewState)
	data.Set("__EVENTVALIDATION", eventValidation)
	data.Set("txtId2", username)
	data.Set("hdnpwd2", encryptedPassword)
	data.Set("imgBtn2.x", "25")
	data.Set("imgBtn2.y", "10")

	req, _ := http.NewRequest("POST", loginURL, strings.NewReader(data.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", "Mozilla/5.0")

	resp2, err := client.Do(req)
	if err != nil {
		return AttendanceResponse{Error: err.Error()}
	}
	defer resp2.Body.Close()
	loginBodyBytes, _ := io.ReadAll(resp2.Body)

	if strings.Contains(string(loginBodyBytes), "Invalid Username") {
		return AttendanceResponse{Error: "Invalid login"}
	}

	resp3, err := client.Get(attendanceURL)
	if err != nil {
		return AttendanceResponse{Error: err.Error()}
	}
	defer resp3.Body.Close()
	doc, err := goquery.NewDocumentFromReader(resp3.Body)
	if err != nil {
		return AttendanceResponse{Error: err.Error()}
	}

	today := getCurrentDate()
	totalPresent, totalClasses := 0, 0
	todaysAttendance := []string{}
	subjectAttendance := []string{}

	headerRow := doc.Find("tr.reportHeading2WithBackground")
	headers := []string{}
	headerRow.Find("td").Each(func(i int, s *goquery.Selection) {
		headers = append(headers, strings.TrimSpace(s.Text()))
	})
	todayIndex := -1
	for i, h := range headers {
		if strings.Contains(h, today) {
			todayIndex = i
			break
		}
	}

	doc.Find("tr[title]").Each(func(i int, s *goquery.Selection) {
		cells := s.Find("td.cellBorder")
		if cells.Length() < 2 {
			return
		}
		subject := strings.TrimSpace(cells.Eq(1).Text())
		attendance := strings.TrimSpace(cells.Eq(cells.Length() - 2).Text())
		percent := strings.TrimSpace(cells.Eq(cells.Length() - 1).Text())

		var present, total int
		if strings.Contains(attendance, "/") {
			fmt.Sscanf(attendance, "%d/%d", &present, &total)
		}
		totalPresent += present
		totalClasses += total

		if todayIndex != -1 && todayIndex < cells.Length() {
			todayText := strings.TrimSpace(cells.Eq(todayIndex).Text())
			statuses := []string{}
			for _, s := range strings.Fields(todayText) {
				if s == "P" || s == "A" {
					statuses = append(statuses, s)
				}
			}
			if len(statuses) > 0 {
				todaysAttendance = append(todaysAttendance, fmt.Sprintf("%s: %s", subject, strings.Join(statuses, " ")))
			}
		}
		subjectAttendance = append(subjectAttendance, fmt.Sprintf("%-20s %7s %s", subject, attendance, percent))
	})

	overallPercentage := 0.0
	if totalClasses > 0 {
		overallPercentage = float64(totalPresent) / float64(totalClasses) * 100
	}

	skippable := calculateSkippableHours(totalPresent, totalClasses)
	required := calculateRequiredHours(totalPresent, totalClasses)

	return AttendanceResponse{
		StudentID:         username,
		TotalPresent:      totalPresent,
		TotalClasses:      totalClasses,
		OverallPercentage: overallPercentage,
		TodaysAttendance:  todaysAttendance,
		SubjectAttendance: subjectAttendance,
		SkippableHours:    skippable,
		RequiredHours:     required,
	}
}

func attendanceHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	resp := FetchAttendanceAPI(req.Username, req.Password)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func main() {
	http.HandleFunc("/attendance", attendanceHandler)
	fmt.Println("Server started at :8080")
	http.ListenAndServe(":8080", nil)
}
