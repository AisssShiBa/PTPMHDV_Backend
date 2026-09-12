package com.ptpmhdv.userservice.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class CreateUserRequest {

    @NotBlank(message = "authUserId is required")
    private String authUserId;

    @NotBlank(message = "email is required")
    @Email(message = "email format is invalid")
    private String email;
}
